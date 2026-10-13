# 成本回采/用量计量设计：usage_events 事件日志（决策 #25 ④）

- 状态：**Wave A 地基、Wave B（LLM 埋点）、Wave C（采集埋点）与 Wave D 读侧均已落地（2026-10-14）**
- 日期：2026-10-14
- 关联：[待拍板决策清单 #25](待拍板决策清单-20260910.md) ④；[design-llm-model-provisioning-20261003.md](design-llm-model-provisioning-20261003.md)（builtin/BYOK 路由）；[design-websearch-job-discovery-20261008.md](design-websearch-job-discovery-20261008.md)（Tavily 付费搜索）

## 1. 背景与动机

决策 #25 ④（2026-10-13 拍板）：**自建 JD 上线后启动成本回采——目的不是定价，是先知道哪个功能在烧钱。**

当前三个成本盲区：

1. **内置 LLM**（求职信 / 简历润色 / JD 抽取 / 语义摘要）走平台 env key（决策 #21 builtin 轨），token 消耗无任何记录；
2. **Tavily 搜岗**是付费搜索（决策 #16 扩展），只有「任务创建」记录、没有真实查询次数计量；
3. **分析作业**消耗 GitHub/Gitee API 额度（平台资源），单源/双源融合作业成本权重不同（demo 配额权重 1|2，见运行架构第 7 条），但没有持久化计量。

没有这些数据，「哪个功能在烧钱」只能靠猜，定价与配额决策没有事实底座。

## 2. 设计原则（决策 #25 ④ 拍板口径）

1. **只追加 `usage_events` 事件日志**——不建汇总表、不改既有表、不回写；
2. **记原始单位（token 数 / 调用次数），绝不记金额**——单价会漂移，金额在读侧按当时单价现算；
3. **metering fail-open**——计量失败只 `console.error`，绝不打断产品主链路；
4. **值域应用侧守门**——DB 无 CHECK，`category`/`feature`/`billingSource` 的演化靠 `packages/shared` 的 Zod 契约约束，新增枚举值先改契约再落地。

## 3. 数据模型（迁移 038，双方言）

一行 = 一次可计费功能调用的原始计量记录：

| 列 | 类型 | 说明 |
| --- | --- | --- |
| `id` | TEXT PK | `usg-<uuid>`，recorder 生成（参考 `job_run_events` 的 `evt-` 惯例） |
| `account_id` | TEXT NULL | 触发账号；匿名/平台级事件为 NULL。**刻意不建外键不级联**：账号删除后成本数据仍保留（成本数据是平台的观测资产） |
| `category` | TEXT NOT NULL | 成本大类：`llm` \| `search` \| `analysis` |
| `feature` | TEXT NOT NULL | 功能点：`cover_letter` \| `resume_polish` \| `jd_extraction` \| `semantic_summary` \| `websearch` \| `analysis_job` |
| `billing_source` | TEXT NOT NULL | 谁掏钱：`builtin`（平台内置模型）\| `byok`（用户 key）\| `platform`（平台基础设施：Tavily、GitHub/Gitee 额度） |
| `provider` | TEXT NULL | 提供方标识（LLM provider 名 / `tavily` / `github` / `gitee` / `all`） |
| `model` | TEXT NULL | 模型标识（仅 LLM 事件） |
| `prompt_tokens` / `completion_tokens` | INTEGER NULL | 输入/输出 token 数（仅 LLM 事件） |
| `quantity` | INTEGER NULL | 非 token 单位（Tavily 查询数、分析作业成本权重 1\|2） |
| `created_at` | TEXT NOT NULL | 事件时刻（UTC ISO8601，recorder 注入） |

索引：`created_at` / `(account_id, created_at)` / `(category, created_at)`——全部服务于「带时间窗的聚合查询」，没有任何点查路径。

**为什么 BYOK 也要记**：BYOK 事件平台零成本，但它是「BYOK 渗透率 × 功能热度」的产品判断依据，且读侧按 `billing_source` 分组天然隔离。

## 4. 写口：UsageRecorder（唯一入口，fail-open）

业务侧埋点只经 `packages/storage` 的 `createUsageRecorder(repo)`：

- `record(input)` 注入 `id` 与 `created_at`，可选字段缺省归一 `null`，然后 `repo.insert`；
- **任何错误（含仓储同步抛出）只 `console.error('[usage] ...')`，永不向外抛**——计量绝不能打断求职信生成、搜岗、分析这些主链路；
- `createNullUsageRecorder()`：测试/缺省装配用 no-op。

仓储 `IUsageEventsRepository` 只有 `insert` + 两个聚合读口，**不暴露 UPDATE/DELETE**。

## 5. 读口：聚合查询（只读）

- `summarize(query)`：按 `(category, feature, billingSource)` 分组聚合，窗口内 `count(*)` 与三个 sum；sum 对全 NULL 组 `COALESCE` 兜底 0（绝不冒 null）；排序确定（三列升序）。
- `summarizeDaily(query)`：按 UTC 自然日（`'YYYY-MM-DD'`）+ `category` 聚合，出日趋势。
- 过滤口径两读口一致：`sinceIso` **含**、`untilIso` **不含**；`accountId`/`category` 可选；**`sinceIso` 必填——拒绝全表扫描**。
- 方言差异（SQLite `date()` vs PG `to_char(::timestamptz AT TIME ZONE 'UTC')`、文本时间比较走 `tsGte/tsLt` 钉型防池化串 42883）只在仓储内部，业务侧只看到 camelCase 行。

## 6. 接缝清单（Wave A 已落地）

| 位置 | 接缝 |
| --- | --- |
| `apps/api/src/routes/types.ts` | `ApiRepos.usageEvents` + `ApiDeps.usageRecorder?`（测试注入 fake / null recorder） |
| `apps/api/src/routes/context.ts` | `RouteDeps.usageRecorder` |
| `apps/api/src/index.ts` | 装配 `deps.usageRecorder ?? createUsageRecorder(repos.usageEvents)` |
| `apps/api/src/routes/agent.ts` + `agent-runner.ts` | `runAgentTickOnce` 的 `deps.usage`（Wave B 的 JD 抽取埋点经它落库） |
| `apps/worker/src/index.ts` | `ClaimOneDeps`/`WorkerDeps.usageRecorder?` + `processJob` 第 5 参 `_usage`（Wave C 消费；注入测试 repos 时默认 null recorder，与既有 deps 注入惯例一致） |
| `apps/api/src/routes/system.ts` | `REQUIRED_COLUMNS += usage_events.billing_source` |

**为什么 recorder fail-open 还必须进漂移守卫**：缺表/缺列时 insert 失败被静默吞掉，计量全丢无人知晓——`/health?deep=1` 是唯一会喊出缺口的读者。合并顺序硬勾选（迁移先上生产再合并 `dev → main`）负责兜底 503 窗口。

## 7. 波次编排

- **Wave A（本文档，已落地）**：shared 契约 + 迁移 038 + 仓储双方言 + recorder + API/worker 接缝 + 漂移守卫 + 测试；
- **Wave B（LLM 埋点，已落地 2026-10-14）**：`OpenAICompatibleClient` 经 per-call 观察者透出 `usage`；实际埋点三处——cover-letter / resume-polish / JD 抽取（语义摘要无在线 API 路径，本波不埋），`billingSource` 按决策 #21 路由结果定（BYOK 优先→内置回落）；实际挂点与口径见 §7.1；
- **Wave C（采集埋点，已落地 2026-10-14）**：search-source Tavily 查询数（`websearch`/`platform`）+ worker 分析作业（`analysis_job`/`platform`，成本权重 1|2 与 demo 配额同口径）；实际挂点与口径见 §7.2；
- **Wave D（读侧，已落地 2026-10-14）**：`/account/usage`（本人窗口聚合，accountId 强制＝当次账号）、`/admin/usage`（全平台，admin 闸复用 llm 路由 `requireAdmin`）、CLI `usage summary|daily`（运营工具无身份闸）、API.md §3.12 登记；窗口护栏＝sinceIso 距今 ≤180 天（代码常量）。

### 7.1 Wave B 实际挂点与口径（2026-10-14 落地记录）

**llm 包透出形状**：`OpenAICompatibleClient` 用 `LlmUsageSchema`（`prompt_tokens`/`completion_tokens` 均 optional、非负整数、`.strip()`）守门响应里的 `usage`——usage 整体缺失或字段缺失都容忍为 null，计量解析绝不让主调用 fail；透出通道是 per-call 观察者 `LlmJsonRequest.onUsage`，成功路径恰好回调一次、失败路径绝不回调。`FakeLlmClient` 第三构造参可控返回 usage（静态值或 `(request, callIndex) => usage` 函数），未配时回双 null。polish/cover-letter/JD 三个 provider 只转发 `onUsage`，自身不感知计量。

**三处埋点（全部在线 API 路径）**：

| 功能点 | 埋点位置 | billingSource 判据 |
| --- | --- | --- |
| `cover_letter` | `apps/api/src/routes/resumes.ts` 的 `POST /resumes/cover-letter` handler，`generate` 成功后 `record` | 当次 `resolveTextLlm` 返回的 `source`（`'byok'`→byok，否则 builtin）——按当次真实路由结果，不按账号有没有 BYOK 配置猜 |
| `resume_polish` | 同文件 `POST /resumes/build` 的 polish 分支：以 `MeteredResumePolishProvider` 包装当次 provider 注入 `onUsage`，`polishResume` 返回后按 `succeeded` 标记条件 `record` | 同上 |
| `jd_extraction` | `apps/api/src/agent-runner.ts` 的 `scanOnce` JD 增强块（extractor 成功后；抛错进 catch 不记），recorder 经 `advanceRunOnce`/`scanOnce` 的 `usage?: UsageRecorder` 参数链传入，装配侧 `routes/agent.ts` 三处调用点与 `index.ts` 的 tick 均已透传 | `agentConfig.jdExtractorMeta.billingSource`（缺省 builtin）——meta 由 `apps/api/src/index.ts` 装配 JD extractor 时与 provider/model 一并写入，是「cron 装配只走内置 env」这一装配决策的事实记录；`jd_extraction` 无 BYOK 在线路径 |

**「只记成功完成的 LLM 调用」口径（三处统一）**：

- cover-letter 的 `generate` 抛错走 502 catch，天然不记；
- polish 的 `polishResume` 会把 provider 抛错吞成 `reason:'provider_error'` 正常返回，调用点看不到失败——故包装层以 `succeeded` 标记（`base.polish` 不抛才置位），record 包在条件里；LLM 响应 schema 校验失败（`onUsage` 可能已触发但 provider 随后抛错）同样不记；
- JD 抽取的 extractor 抛错进 `scanOnce` 的 catch，不记；
- token 缺失记 null，绝不编数；`quantity` 恒 null；`provider`/`model` 用当次调用标识，拿不到给 null；`accountId` 在线路径＝当次登录账号 id。

**语义摘要（`semantic_summary`）本波不埋**：L3-B 语义摘要只有 CLI 路径（`semantic analyze --llm` / `analyze --semantic --llm`），在线 API 没有触发路径，无在线埋点可挂。`USAGE_FEATURES` 枚举保留 `semantic_summary`，待语义摘要进在线路径时补埋。

**CLI 本波刻意不埋**：CLI 是本地实验工具、LLM 成本由使用者自付（自带 env key），且 CLI 侧装配 recorder 需要新建 DB 连接——保持简单，本波只埋在线 API 路径。

### 7.2 Wave C 实际挂点与口径（2026-10-14 落地记录）

**search-source 透出形状**：对齐 Wave B 的 per-call 观察者模式——`SearchClient.search` 的 opts 新增 `onQuery?: SearchQueryObserver`（`types.ts`），一次搜索请求被通道实际受理并成功返回时恰好回调一次、请求失败（网络错误/非 2xx）绝不回调；`TavilySearchClient` 在成功 `return` 前回调（两个 throw 分支天然不回调）。计量计数在执行器 `run.ts` 的 `executeSearchRun` 内完成（`queriesSent` 计数器 + 两处 search 调用透传 `onQuery`），不改变既有返回类型语义。

**两处埋点**：

| 功能点 | 埋点位置 | 口径 |
| --- | --- | --- |
| `websearch`（category=search，billingSource=platform，provider=`tavily`） | `packages/search-source/src/run.ts` 的 `executeSearchRun`：ATS 召回之后、入库阶段之前记一条，`quantity=queriesSent`；recorder 经 `RunSearchDeps.usage?` 传入，装配点 `apps/api/src/routes/search.ts` 的 search-tick handler 传 `d.usageRecorder` | **发出即计入**——记录点刻意放在 JD 抽取/落库之前，后续失败不清零；`queries` 为空（回落规则未产查询）或 Tavily 全部未受理时 `queriesSent=0`，一条不记；`accountId`=搜岗任务创建账号，token/model 恒 null |
| `analysis_job`（category=analysis，billingSource=platform） | `apps/worker/src/index.ts`：成功终态（含 partial 降级终态）在 `processJob` 成功路径记录；失败终态在 `handleJobFailure` 判定不再重试的两个 `jobs.fail` 分支（not_found / attempts≥maxRetries）记录，中间重试（重排 queued）不记——两侧合起来保证**一次作业恰好一条**；recorder 即 Wave A 预留接缝（`_usage` 改名 `usage`），由 `claimAndProcessOne` 装配透传 | `quantity`=成本权重：请求平台 `all` 时读 `DEMO_FUSION_QUOTA_COST`（默认 2、最小 1，worker 侧自解析、不 import apps/api，解析规则与 `demo-config.ts` 对齐），单源恒 1；`provider`=实际持久化平台（`all` 降级纯 GitHub 时记 `github`，权重仍按 `all` 计；失败终态无持久化产物，记请求平台——额度在 collect 阶段已真实消耗）；`accountId`=null（平台算力），token/model 恒 null |

**僵尸任务天然安全**：`reclaimStaleRunning` 只把 >5 分钟的 running 行重置回 queued，不记事件；只有到达终态（succeeded/failed）才产生记录，崩溃恢复不会重复计数。

## 8. 明确不做什么

- **不记金额、不建单价表**（单价漂移会让历史数据失真；金额在读侧按当时单价现算）；
- **不建外键、不级联**（`account_id` 允许悬挂）；
- **不做实时聚合/物化视图**（量级小，窗口聚合查询足够；读侧慢了再优化）；
- **Wave A 当时不 mount 任何 HTTP 路由**（读侧留给 Wave D；`/account/usage` 与 `/admin/usage` 已随 Wave D 于 2026-10-14 挂载）；
- **不用计量做配额/限流**（配额仍走 `demo_sessions` 既有机制；`usage_events` 是只读观测面，绝不在请求路径上做条件判断）。

## 9. 测试

- `packages/shared/src/usage.test.ts`：Zod 守门（值域拒绝、负/小数 token 拒绝、日期格式守门、`sinceIso` 必填）；
- `packages/storage/src/usage-events.test.ts`：SQLite 仓储（聚合分组/排序/COALESCE/窗口含排他/accountId 与 category 过滤/匿名行不匹配 account 过滤/日 bucket）+ recorder（`usg-` 前缀、ISO 注入、null 归一、fail-open 吞错只日志）；
- `packages/storage/src/postgres-behavior.test.ts` pgIt：PG 方言对等（insert + 聚合 + `::timestamptz` 日 bucket + 文本时间比较不 42883；accountId 过滤隔离保证连跑不假红）。
