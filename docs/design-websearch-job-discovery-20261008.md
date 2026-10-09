# 设计 · 指令式全网搜岗 + 筛选条件预设（WebSearch Job Discovery）

- 状态：**已拍板、P0 已上线（2026-10-09 随 PR #152 合并 main）**
- 一句话：在保留定时采集（五源自动入池）的同时，新增**用户主动驱动的指令式全网搜岗**——用户用自然语言下条件（如"深圳的 Java 开发、坐班、可远程"），Agent 按条件全网搜索并抓取解析入池；条件可**保存为筛选条件预设**（列表维护：保存/删除）。
- 关联：[设计-求职Agent-20261002.md](设计-求职Agent-20261002.md)（Agent 六步闭环与状态机）、[design-job-ingestion-20260913.md](design-job-ingestion-20260913.md)（岗位池/五源采集）、[design-llm-model-provisioning-20261003.md](design-llm-model-provisioning-20261003.md)（LLM 双轨供给）、[设计-求职Agent-20261002.md §3.2 C1](设计-求职Agent-20261002.md)（LLM 读 JD 语义理解，本设计的落地场景）。

## 0. 需求拆解：双模式并存

| 维度 | 定时采集（现状，保留） | 指令式全网搜岗（新增） |
| --- | --- | --- |
| 触发 | Cron 定时（CF Worker `*/5` agent-tick + 日更/月度 Actions） | **用户主动发起**（工作台指令输入） |
| 岗位来源 | 固定五源：RemoteOK/Remotive/Greenhouse/Lever/HN+WWR | **全网**：搜索 API × 多 query → 招聘页（Greenhouse/Lever/公司 careers/LinkedIn/Indeed…） |
| 输入 | `job_preferences`（结构化偏好，长期任务） | 自然语言指令（可保存为**筛选条件预设**） |
| 结果 | 增量入池 → 待投清单 | 搜索 → 抓取解析 → **入同一岗位池** → 打分 → 待投清单 |

两者**共用岗位池、匹配、质量闸、去重、人机闸**——新增的只是"岗位怎么来"的前半段。

## 1. 目标形态（用户视角）

1. 工作台出现**搜岗指令框**：输入"我想找 AI Agent 开发，远程，年薪 30w+，英语好加分"→ 点"全网搜岗"。
2. Agent 解析条件 → 全网搜索 → 抓取解析 → 入库 → 按画像/条件打分 → 结果页/待投清单展示（可解释：来自哪个 URL、匹配理由）。
3. 指令框旁"**保存此条件**"→ 存入筛选条件预设列表；预设可**列表查看、删除**；下次点预设一键再搜。
4. 结果可进待投清单，投递仍走人机闸（用户确认 → 扩展填表 → 用户按提交）。

## 2. 数据流（照此能落代码）

```
① 用户输入自然语言指令（或从预设一键发起）
      │
② 意图解析（LLM，fail-closed）
      │   LLM：指令 → 结构化搜索条件 { queries[], filters }
      │   { queries: ["AI Agent developer", "AI agent 开发"], filters: { remote:true, location:"深圳", salaryMin:300k, keywords:["AI Agent"] } }
      │   无 key / 校验失败 → 规则解析降级（关键词切分 + 预设透传），不阻塞
      ▼
③ 全网搜索（新 packages/search-source）
      │   搜索 API（主 Tavily，备 SerpAPI Google Jobs）× 每 query 1-3 次搜索
      │   → 招聘页 URL 候选列表（同源去重 + 平台黑名单）
      ▼
④ 抓取 + JD 抽取
      │   抓取页面 → LLM 结构化提取（title/company/location/remote/salary/skills），Zod 校验
      │   失败回落启发式（meta/JSON-LD/h1+正文正则）；无法抽取的 URL 丢弃并记原因
      ▼
⑤ 规范化入库（job_postings，source='websearch'）
      │   与现有池去重（URL 归一 + 标题×公司 7 天窗，复用跨源同帖去重逻辑）
      ▼
⑥ 现有管道复用：matchScoreTier 打分 → 质量闸 → 待投清单 / 结果列表
      ▼
⑦ 用户确认 → 扩展填表 → 用户按提交（人机闸不变）
```

## 3. 数据模型（迁移草案，双方言，编号续 031+）

| 表 | 字段（要点） | 说明 |
| --- | --- | --- |
| `search_presets`（新） | `id, account_id, title(可空), query(原始指令文本), conditions(JSONB: queries[]/location/remote/salary_min/keywords), created_at, updated_at` | **筛选条件预设**：用户保存的搜索条件，列表维护（增删）；按 `account_id` 隔离 |
| `search_runs`（新） | `id, account_id, preset_id(可空,关联), status(queued/running/done/partial/failed), queries[], results_count, new_count(入池新增数), error(可空), created_at/updated_at` | 一次指令式搜岗任务（异步，worker 消费）；结果摘要可回显 |
| `job_postings`（扩） | 加 `source` 取值 `'websearch'`（现有 source 已枚举 remoteok 等；新增枚举值） | 标记来源，统计/追踪用；`origin` 语义不变 |
| `job_run_events`（复用） | 不加字段 | 预设一键发起可落一条 agent 事件（审计） |

> 迁移规范照 [MIGRATION_CONVENTION.md](../MIGRATION_CONVENTION.md)：编号 `NNN_verb_snake_case.sql`、双方言对称、幂等、COMMENT ON。

## 4. API 草案（apps/api，登录闸 + 归属校验）

**搜岗**
- `POST /agent/search`：body = `{ query: string, presetId?: string }` → 创建 `search_runs(queued)`，立即返回 `runId`；worker 消费执行搜索
- `GET /agent/search/:id`：任务状态 + 结果摘要（new_count / partial 原因）
- `GET /agent/search/:id/results`：本次搜到的岗位列表（含来源 URL、匹配分、是否已入待投清单）
- `POST /agent/search/:id/to-intents`：把本次结果（过质量闸的）并入待投清单（人机闸票据，复用现有 approve 链）

**筛选条件预设（用户主动维护，本人）**
- `GET /agent/search-presets`：我的预设列表
- `POST /agent/search-presets`：保存预设（`{ title?, query, conditions }`；同一 `query` 幂等 upsert）
- `DELETE /agent/search-presets/:id`：删除（本人；已有 search_runs 引用时软删/保留历史）
- `DELETE /agent/search-presets`：**清空本人全部预设**（hard delete；`search_runs` 存 query+conditions 快照，不依赖 preset，安全）

**搜岗历史（每次发起自动记录，本人）**
- `GET /agent/search`：我的搜岗历史列表（`search_runs` 倒序，最多 20 条）
- `DELETE /agent/search-runs/:id`：单删一条历史
- `DELETE /agent/search-runs`：清空本人全部历史
- **语义硬约束：删历史 ≠ 删岗位**——`job_postings` 是共享池，其他用户/其他入口仍可见，绝不级联删除

> 全部端点要求 `kind='user'`（401）；demo 模式只读体验或按配额放行（沿现有 demo 闸模式，细节见 §7 决策点 4）。

## 5. UI 草案（apps/report 工作台）

- 工作台新增「**全网搜岗**」卡片：指令输入框 + 「搜」按钮 + 「保存此条件」按钮；输入即提示可保存为预设。
- 「**我的筛选条件**」列表（预设 CRUD）：每条显示 title/query/条件摘要，操作＝「再搜一次」/「删除」；头部「清空全部」（`window.confirm` 二次确认，不可逆）；空态引导。
- 「**搜岗历史**」区块（同栏预设下方）：每次搜岗自动记录；每条显示状态 chip + query + 结果/新增计数，操作＝「删除」（单删）；头部「清空全部」（二次确认，不可逆）；点击历史条目标题可把该 query 回填指令框。
- 搜索结果区：任务进行中（spinner + 已抓取 N 条）、完成后岗位卡片列表（来源站徽标、匹配理由、加入待投清单按钮）。
- i18n 中英双语 key；样式沿用 design token；组件级单测 + 工作台全栈 E2E（沿用 `e2e/agent/workbench-fullstack.spec.ts` 模式）。

## 6. LLM 角色（延续确定性分层）

| 环节 | LLM 是否参与 | fail-closed 行为 |
| --- | --- | --- |
| 意图解析（指令→条件） | ✅（LLM 读指令结构化） | 无 key/校验失败 → 规则关键词解析 + 预设原样透传 |
| JD 抽取（页面→字段） | ✅（结构化提取） | 失败回落启发式（JSON-LD/meta/正则），无法抽取丢弃记因 |
| 匹配分 / 质量闸 / 去重 / 状态机 | ❌ 永远规则引擎 | —— |
| 投递决策 | ❌ 人机闸 | —— |

> 本设计的 JD 抽取＝求职 Agent 设计里 **C1「LLM 读 JD 补语义理解」的落地场景**（§3.2），不重复立项。

## 7. 搜索通道选型（事实已核实，2026-10）

| 通道 | 免费层 | 起步价 | 对"找岗位"的价值 | 结论 |
| --- | --- | --- | --- | --- |
| **Tavily** | 1000 credits/月（免卡） | PAYG $0.008/credit | Search+Extract 一体、agent 原生、覆盖好 | **主通道**（开发验证期免费层够用） |
| **SerpAPI** | 250 次/月（评估用，商业需付费） | $25/月=1000 次 | **Google Jobs 引擎**直接返回结构化岗位 JSON | **备选增强通道**（若验证期召回质量不足再启用） |
| **Brave** | 2000 次/月（2026 起新用户改 $5 信用金） | Base AI $5/1K | 通用搜索、输出干净 | 暂缓（无岗位专用引擎） |

**建议**：P0 只接 Tavily（`TAVILY_API_KEY` env，凭证不进数据面，对齐 LLM 供给不变量）；SerpAPI Google Jobs 作为 P1 增强待验证数据决定。

## 8. 风险与对策

| 风险 | 对策 |
| --- | --- |
| 搜索成本失控 | **触发硬约束：搜岗只允许用户主动发起（登录态 `POST /api/agent/search`），禁止任何定时/自动创建搜索任务的路径**——定时调度（CF Worker `*/5` 调 `search-tick`）只**消费**已存在的 queued 任务，队列空即 idle 返回、零 Tavily 调用；叠加账号级限流（每次搜岗 ≤3 query × 每 query ≤5 结果）+ 结果缓存复用（同预设 24h 内不重复搜） |
| 第三方页抓取合规/反爬 | 只抓公开招聘页、尊重 robots、低频率（与现有采集同一纪律）；被封 URL 记失败原因 |
| LLM 抽取幻觉（JD 字段造错） | Zod 校验 + 失败回落启发式 + 标记"AI 抽取，仅供参考"；**搜索结果不产生画像证据**（不动可信证据链） |
| 与现有池重复 | 复用跨源同帖去重（URL 归一 + 标题×公司 7 天窗）；重复岗位直接关联而非二次入库 |
| 海投风险 | 结果进待投清单仍过质量闸；投递仍人机闸（决策 #20 不变） |
| 预设误删 | DELETE 软删（历史 search_runs 引用保留）；列表二次确认 |

## 9. 实施分期（待拍板后排序）

- **P0（纯代码闭环）**：迁移（`search_presets` + `search_runs` + `job_postings.source` 枚举）+ `packages/search-source`（Tavily 适配器 + 意图解析回落 + JD 抽取 + 去重入库）+ API 4 组端点 + 工作台 UI（指令框 + 预设 CRUD + 结果列表）+ i18n + 单测/E2E。**需用户配 `TAVILY_API_KEY`**（P0 完成前 UI 显示"未配置"降级提示）。
- **P1（增强）**：SerpAPI Google Jobs 通道；结果"一键存为求职任务偏好"（预设→JobRun 升级路径）；搜岗用量统计。
- **P2（缓做）**：对话式搜岗（把指令框升级为会话流）。
- ~~定时按预设自动搜岗~~ **已取消（2026-10-09 用户决策）**：websearch 走付费搜索（Tavily credits），**只允许用户主动触发**；禁止任何定时/自动触发路径。定时调度只负责消费用户已创建的 queued 任务，不创建新任务。

## 10. 待拍板决策点

| # | 决策 | 助手建议 | 状态 |
| --- | --- | --- | --- |
| 1 | 搜索通道 | **Tavily 主通道**（P0 就要配 `TAVILY_API_KEY`）；SerpAPI Google Jobs 备选 P1 | ✅ **已拍板 2026-10-08：先用 Tavily，其他 API 作备选** |
| 2 | 优先级 | 相对 J7（生产 LLM_*）/ B4（Supabase 备份）/ CWS 上架——建议 P0 排在这些之后（不阻塞上线），或用户指定插队 | ✅ **已拍板 2026-10-08：插队，直接开 P0** |
| 3 | 预设与 job_preferences 的关系 | 独立 `search_presets`（搜索配方）与 `job_preferences`（长期任务）并存；P1 提供"预设→创建求职任务"升级按钮 | ✅ **收口 2026-10-09：P0 已按并存实现并上线**（P1 升级按钮缓做） |
| 4 | demo 模式放行 | demo 用户可体验搜岗但结果不可入待投清单（只读预览 + 配额限制），正式搜岗需登录 | ✅ **收口 2026-10-09：P0 已按需登录 + demo 只读实现并上线** |
| 5 | 触发方式与成本闸 | **仅用户主动触发**（`POST /agent/search`，需登录）；定时调度只消费不创建；P2「定时按预设自动搜岗」取消 | ✅ **已拍板 2026-10-09：搜岗必须主动，不要自动触发，否则账单会爆** |

## 11. 决策记录

- 2026-10-08：用户提出新功能——① 保留定时采集；② 新增**用户主动指令式全网搜岗**（自然语言条件 → Agent 全网找岗位）；③ 附加**筛选条件预设列表**（保存/删除/维护）。本设计文档立项，决策点待拍板。
- 2026-10-08：**用户拍板**——① 搜索通道＝**Tavily 主通道**（其他 API 作备选）；② **优先级＝插队**（P0 直接开干，不等 J7/B4/CWS）。P0 开工。
- 2026-10-09：**P0 全链落地并随 PR #152 合并上线**（含 undici overrides 恢复 + vitest 对齐修复）。决策点 3/4 收口（P0 实现即最终形态：预设与 job_preferences 并存、搜岗需登录、demo 只读）。生产前置＝迁移 032/033 执行 + `TAVILY_API_KEY` 配置。
- 2026-10-09：**用户决策（成本硬约束）**——搜岗是付费搜索，**必须用户主动触发，禁止自动/定时触发，否则账单会爆**。落地方案：唯一创建路径＝登录态 `POST /api/agent/search`；调度器（CF Worker `*/5` → `search-tick`）只认领执行已存在任务、空转零 Tavily 调用；P2「定时按预设自动搜岗」取消。同日生产迁移 032/033 已执行验证（`search_presets`/`search_runs` 表 + `job_postings.search_run_id` 列）。
