# AGENTS.md — JobAgent 项目指令

本文档供在本仓库工作的 AI coding agents 使用。**修改代码或文档前应先通读本文件**，并保持本文档与项目实际状态同步。本文件是项目工程约定的单一事实源；`CLAUDE.md` 只引用本文件。工程惯例与 `agent-world` 对齐。

## 0. 任务追踪与文档分层（接手先读 handoff）

- **[handoff.md](handoff.md) 是任务追踪主入口**：当前状态 + 活跃待办 + 最近变更 + 「Project documents」文档索引。任何 agent 接手先读它。
- **全文设计放 [docs/](docs/)**：一个主题一份文档（产品、技术选型、design-*），设计文档只写设计，不重复记流水进度。
- **缓做事项放 [docs/deferred-items.md](docs/deferred-items.md)**：每条必须带**触发条件**；触发后移回 handoff 待办并标「已重启日期」。
- **[docs/README.md](docs/README.md)** 是"我想做 X 该看哪个"的场景导航，不重复维护清单（清单以 handoff 为准）。
- **新增任何文档后**：在 handoff「Project documents」登记一行（含一句话定位），并在 docs/README 补场景入口。
- **handoff 归档惯例（2026-09-18 起执行，对齐 agent-world）**：主文件只保留「项目当前状态 + 活跃任务 + 最近 5 条变更 + 文档索引」；编号待办标 ✅ 后，详细过程（实现步骤 / commit 链 / 踩坑 / 验证数据）整块滚入 `docs/handoff-archive-YYYY-MM-DD.md`，主文件只留**一行结论 + commit hash**；真正在推进 / 还在跑的活跃项保留详情；归档文件冻结只读、不再追加。首个归档 [docs/handoff-archive-2026-09-18.md](docs/handoff-archive-2026-09-18.md)。
- 文档状态：现行 / 历史 / 归档；实施进度统一记 handoff。

## 项目概览

JobAgent 把开发者的 GitHub/Gitee 行为痕迹（commit / PR / Issue / 项目演进）分析为**可信、可解释、可复核**的能力画像，服务于技术招聘与应聘。当前 **M1 完成、P1 扩展稳定、P2 职位聚合+画像↔岗位匹配完成、GitHub/Gitee 双源、演示模式 Demo Mode 已落地**（阶段与待办以 handoff.md 为准）。

- 包管理器：**pnpm workspaces**（`pnpm-workspace.yaml`，不使用 npm/yarn，避免多套 lockfile）
- Node 版本以 **[.nvmrc](.nvmrc)** 为准（`nvm use`）；语言 TypeScript（**strict**、ESM）
- 后端：Hono + Zod；分析任务由独立 Worker 消费
- 数据库：**SQLite（本地/实验）+ PostgreSQL（生产）双方言** + Drizzle ORM（**Drizzle 与方言差异只允许出现在 `packages/storage` 内部**，业务只依赖统一 async 仓储接口与 `createStorage()` 工厂、按 `DB_DRIVER` 切换，见下；MVP 不引入 Redis）
- GitHub 采集：官方 Octokit，GraphQL 批量优先、REST 补；生产用 GitHub App
- Gitee 采集（第二证据源，2026-09-14 G-A+G-B 落地）：官方 v5 **REST-only（无 GraphQL）**，匿名可读公开数据、`GITEE_TOKEN` 可选仅提额；产出与 GitHub 一致的证据源无关 `AnalyzerInput`，CLI `--platform gitee` 与在线链路（API `platform` 枚举、Worker 多源路由、报告页/扩展平台切换 UI）均已打通；events 行为流（方案 A 补近期 PushEvent 提交）与行为多样性弱信号（方案 B：双源聚合源无关 `BehaviorEventSummary`、analyzer 新增 `narrow_activity_scope`、规则版本 0.1→0.2）均已于 2026-09-15 落地；跨源镜像去重、在线多源融合画像（`platform=all` 一次作业双采）、跨源 PR/issue 同帖去重（7 天窗 `CROSS_SOURCE_THREAD_WINDOW_MS`，2026-09-18 锁定）与融合作业配额权重（demo 扣 2）均已落地；Gitee OAuth 登录/认领已随 item33（2026-09-19）落地（见 docs/design-gitee-oauth-20260919.md），仅剩真实 Gitee App 凭证首次冒烟与认证态精确限频缓做（见 deferred #12、docs/design-gitee-source-20260914.md、docs/design-behavior-diversity-20260915.md、docs/design-cross-source-fusion-20260915.md）
- 页面：Astro + React islands；落地页是独立工程 `../job-agent-landing`；浏览器扩展 `apps/extension`（P1：三大 ATS 一键填充）
- 测试：Vitest（就近单元）+ Playwright（E2E）
- 分析深度：MVP 仅 **L0 元数据 + L1 行为时序**，**不 clone 仓库**（L2/L3/L4 见 docs/deferred-items）

> 选型理由、备选方案与待核实项见 [docs/技术选型-MVP-20260910.md](docs/技术选型-MVP-20260910.md)；产品范围以 [docs/PRD.md](docs/PRD.md) 为准；未拍板事项见 [docs/待拍板决策清单-20260910.md](docs/待拍板决策清单-20260910.md)，**不得把"建议"当作"已决策"直接实现**。

## 项目结构（已按技术选型文档第 7 章落地，2026-09-10 脚手架）

```text
job-agent/
├─ packages/
│  ├─ shared/         # AbilityProfile/EvidenceItem/JobPosting 类型 + Zod 契约（单一事实源，JobPosting 为 P2 预留）
│  ├─ storage/        # 持久化抽象层：仓储接口（统一 async）+ entities 共享 + sqlite/postgres 双实现 + 迁移器（业务模块禁裸 SQL；设计见 docs/design-storage-dual-dialect-20260911.md）
│  ├─ github-source/  # Octokit、GraphQL 查询、L0/L1 采集、限频/缓存（首个 EvidenceSource）
│  ├─ gitee-source/   # 第二个 EvidenceSource：Gitee v5 REST-only 采集→证据源无关 AnalyzerInput（CLI --platform 选源；设计见 docs/design-gitee-source-20260914.md）
│  ├─ analyzer-core/  # 纯函数：行为信号→真实性分级→能力标签→画像装配；规则版本化
│  ├─ resume-core/    # 纯函数：画像+岗位+匹配→岗位定向简历 ResumeDraft（match-input 映射 / rank 排序 / tailor 装配 / render md+html / polish 受约束润色安全层；只重排不造事实，设计见 docs/design-targeted-resume-20260915.md）
│  ├─ llm/            # LLM 端口（LlmClient）+ FakeLlmClient（测试）+ OpenAICompatibleClient（/chat/completions，注入 fetch 测试）+ LlmResumePolishProvider（Zod 校验）；createResumePolishProviderFromEnv 无 LLM_API_KEY 返回 null（默认关闭走规则版），凭证只从服务端 LLM_* env 读（见 .env.example、简历设计 §7/§10）
│  └─ ui-tokens/      # 设计 token 单一事实源（无构建静态 CSS，--ja-* 变量；report 与 extension 共用，设计见 docs/design-tokens-20260910.md）
├─ apps/
│  ├─ api/            # Hono：触发分析、查询任务/画像、只读分享接口
│  ├─ worker/         # 消费 analysis_jobs，调用 github-source + analyzer-core
│  ├─ cli/            # 本地批量分析，导出 JSONL/报告（供决策 #8 标注实验）
│  ├─ report/         # Astro 报告页 + React islands
│  └─ extension/      # P1 浏览器扩展（MV3 + content script + Shadow DOM 面板 + 三 ATS 适配器 + esbuild；试用指南见其 README）
├─ db/migrations/sqlite/   # SQLite 编号迁移（NNN_verb_snake_case.sql）
├─ db/migrations/postgres/ # Postgres 编号迁移（与 sqlite 编号/文件名一一对应），规范见 MIGRATION_CONVENTION.md
├─ tools/             # check-migrations.sh 等只读工程脚本
├─ tests/fixtures/    # 录制并脱敏的 GitHub 响应夹具
└─ docs/              # 产品/技术全文（PRD、技术选型、决策清单、讨论、deferred）
```

> 结构已按技术选型文档第 7 章落地；M1 完成 `packages/shared`（Zod 契约）、`packages/storage`（持久化层 + 迁移）、`github-source`/`analyzer-core`/`cli` 与三应用；P1（2026-09-11 拍板）新增 `apps/extension`（真实环境冒烟：Greenhouse/Lever 通过，Workday 平台受限见 handoff）。

## 常用命令

```bash
pnpm install                 # 安装依赖
pnpm -r typecheck            # 全仓类型检查，不产出文件
pnpm -r test                 # 全部就近单测（Vitest）
pnpm -r build                # 构建各 workspace
pnpm --filter <pkg> dev      # 只跑某个包/应用
pnpm --filter <pkg> exec vitest run path/to/file.test.ts  # 跑单个测试文件
pnpm migrate:up / migrate:down / migrate:status          # SQLite 应用/回滚一步/查看状态（默认 data/job-agent.db）；migrate:pg:* 走 Postgres（读 DATABASE_URL）
bash tools/check-migrations.sh   # 校验 sqlite/postgres 两目录命名/编号/文件头 + 文件名集合对齐（可传单目录参数）
pnpm e2e                         # report 页 Playwright E2E（拉起 Astro，mock API）
pnpm e2e:extension               # 扩展 E2E：--headless=new 加载 unpacked MV3、零网络（先 build dist；设计见 docs/design-extension-e2e-20260914.md）
# 岗位定向简历：库模式 --profile <profileId> --job <jobId>；离线模式 --profile <画像.json> --job-file <岗位.json> [--evidence e.json] [--local-fields l.json] [--format md|html|json] [--locale zh-CN|en] [-o out]
pnpm --filter @jobagent/cli build && node apps/cli/dist/index.js resume build --profile <id|file> --job <jobId> --format md -o resume.md
# 多岗位批量（P-R3）：--jobs id1,id2（逐岗含零命中降级）或全库 top --limit N；逐岗写 --out-dir（默认 resumes/，md|html）
node apps/cli/dist/index.js resume batch --profile <id|file> --limit 5 --format md --out-dir resumes
# 认证运维：物理清理过期/已撤销 auth_sessions（默认保留 24h）与无有效会话的未认领闲置 accounts（默认保留 30d），不触碰 profiles/evidence；生产 cron 调度随部署
node apps/cli/dist/index.js auth cleanup [--retain-hours 24] [--account-retain-hours 720]
# 在线生成等价端点：POST /resumes/build {profileId, jobId, local?, locale?, format?}（不入库，见 docs/API.md §3.4）；报告页深链 <locale>/report/<profileId>?resumeJob=<jobId>
docker compose up -d             # Docker 运行时 smoke（SQLite；--profile with-pg 加 PG；需 GITHUB_TOKEN 给 worker）
```

提交或交付前至少完成：typecheck、相关单测、build、迁移校验、`git diff --check`。

## 运行架构（分析管道）

1. 接口收到用户名 → Zod 校验 → 命中未过期画像快照则直接返回。
2. 否则创建 `analysis_jobs(queued)`，API 立即返回 `jobId`。
3. Worker 认领：`github-source` 先取 **L0** 写一版 `partial:L0` 轻画像，再补 **L1** 行为时序。
   - **错误重试策略**：`not_found`（账号/仓库不存在）直接失败不重试；`api_error`/`budget_exhausted` 等瞬时错误重试至多 3 次。
   - **僵尸任务回收**：Worker 启动时将 >5 分钟仍 `running` 的任务重置为 `queued`（崩溃恢复）。
4. `analyzer-core`（**纯函数、带版本、无 I/O**）计算真实性信号、能力标签、规则化面试题，产出完整 `AbilityProfile`。
5. 画像以**不可变快照**写入 `profiles`，证据写入 `evidence`；分享链接永远指向生成时版本。
6. 任一层失败必须显式标注缺失，**禁止输出"看似完整"的报告**。
7. **演示模式三态身份（anonymous/demo/user，设计见 docs/design-demo-mode-20260915.md）**：只读公开端点全放行；唯一受限是"触发新分析"，画像缓存命中先于权限检查、任何身份放行且不扣配额；demo（HttpOnly Cookie `jobagent_demo`）经受三道闸——会话单条条件 UPDATE 原子扣减、IP 加盐哈希滑窗、Worker demo 并发闸（formal 永不被闸）。**扣减按作业成本权重（2026-09-18 拍板）**：单源 github/gitee 扣 1，`platform=all` 双源融合作业扣 `fusionAnalyzeCost`（默认 2，env `DEMO_FUSION_QUOTA_COST`，最小 1）；条件 UPDATE 用 `analyze_count + cost <= quota`，**剩余不足 cost 整单影响 0 行、绝不部分扣减**，`jobs.create` 失败在 catch 按原 cost 补偿（SQLite `MAX`/PG `GREATEST` 兜底不为负）；IP 滑窗按请求数计 1、Worker 并发闸不按 cost（all 只占一个 job 槽）。改 `/analyze`、Worker 认领或配额逻辑时必须保持这些顺序与错误码（DEMO_REQUIRED/QUOTA_EXCEEDED/RATE_LIMITED），且**不得把 analyzer-core 拖入身份/配额逻辑**。
8. **报告页授权分级闸与登录回跳（2026-09-19 落地，设计见 [docs/design-auth-gating-20260919.md](docs/design-auth-gating-20260919.md)）**：报告页是 Astro SSR **直读只读 storage（不走 API）**，身份由 `apps/report/src/lib/auth.ts` 的 `resolveViewer` 解析（只读、不 `touch`、坏/过期会话静默降级匿名）。两档可见性——未登录（anonymous/demo）可见结论/技能/匹配/简历/投递与匹配理由证据（决策 #10 要求可回溯），登录 `user` 才可见招聘方三视图**原始证据外链、面试题、`interview-kit.md`**（该端点未登录 `401`）；登录墙用纯 SSR `GateCard`，登录链接必须带同源 `return_to`（API 侧 `sanitizeReturnTo` 白名单防开放重定向）。**JSON API `GET /profiles/:id` 与 `/exportable` 保持公开**（扩展一键填充依赖 exportable，其投影无证据 URL/面试题），字段级 API 裁剪缓做（见 deferred）。改报告页/认证时保持「结论公开、证据原文登录可见」矩阵，勿把 analyzer-core 拖入身份逻辑。

### 内核与 I/O 分离（硬约束）

- `analyzer-core` 不发请求、不读数据库、不读文件系统；输入是采集后的结构化数据，输出是画像，便于对固定夹具做单测。
- `github-source`（Octokit/GraphQL）与 `gitee-source`（Gitee v5 REST-only）是两个 `EvidenceSource`，都产出证据源无关的 `AnalyzerInput`，analyzer 内核不感知来源（`analyze(input,{platform})` 仅切换主体标识与数据来源 caveat）；未来作品集等以同接口新增，内核不改。

## 数据访问抽象层与迁移

### 所有 DB 访问收敛到单一持久化模块（硬约束，对齐 agent-world）

- 设唯一持久化/仓储抽象（如各服务内的 `db.ts` / repository），对外只暴露 `getX/insertX/listX` 等方法；**业务模块内禁止裸 SQL、禁止直接调用驱动/Drizzle 查询**。
- **SQL 方言差异只允许出现在该模块内部**（W3-6 起落地 Postgres/SQLite 双轨：业务只依赖统一 async 仓储接口与 `createStorage()` 工厂，按 `DB_DRIVER` 切换，见 [docs/design-storage-dual-dialect-20260911.md](docs/design-storage-dual-dialect-20260911.md)）；Drizzle 只在这层内部做类型化查询，调用方不感知。
- 数据库字段 `snake_case`，TS 字段 `camelCase`，转换集中在数据访问层。

### 迁移规范

- 结构变更只通过 **`db/migrations/{sqlite,postgres}/NNN_verb_snake_case.sql`** 编号文件（两侧各一份、编号文件名对齐），规则（文件头、幂等、`COMMENT ON`、只追加不重写、回滚）见 [MIGRATION_CONVENTION.md](MIGRATION_CONVENTION.md)。
- W1 已落地：迁移器（按序应用）、`scripts/migrate-down`（回滚一步，无安全 down 则拒绝）、`migrations.test.ts`（干净库顺序加载/编号连续/关键表存在），实现见 `packages/storage`。**W3-6 已扩展为双方言**：`db/migrations/{sqlite,postgres}` 对称目录、双方言 schema/迁移文本一致性测试防漂移、`postgres-behavior.test.ts` 仅在 `DATABASE_TEST_URL` 存在时实跑（否则 skip）；CI 提供 `postgres:16-alpine` service 并注入该变量，双方言测试在流水线真实 PG 上实跑；新增/改表必须两侧各一份编号文件名对齐的迁移，`bash tools/check-migrations.sh` 会校验对齐。
- M1 核心表：`profiles`（画像快照 JSONB + analyzerVersion + 时间窗）、`evidence`、`analysis_jobs`、`waitlist`；演示模式 006–008（demo_sessions/demo_ip_windows 等）；账号主脊 010 `accounts`、011 `auth_sessions`（GitHub/Gitee 双 OAuth 登录 + 本人认领，2026-09-18/19 落地）。Gitee OAuth 仅差真实 App 凭证首次冒烟（见 deferred）。
- 画像存**快照**而非实时重算，避免源数据变化导致已分享结论漂移；优先存**证据指针与精简原始快照（带 ETag）**，不做无标注全量拷贝。

## GitHub 采集与外部约束

- 只用官方 **Octokit**，启用 throttling / retry 插件处理次级限频；**凭证只在服务端，绝不下发前端、不入 Git**。
- 限额以 GitHub 官方文档当期值为准（2026-09-18 已复核精确值，写回技术选型 6.7）：非企业 installation token 起步 REST 约 5,000 次/小时、GraphQL 约 5,000 点/小时，>20 仓库/组织成员逐档加成、上限均 12,500/小时；GitHub App 额度更高。
- 必须实现：单画像调用预算、ETag 条件请求、缓存优先、限频退避、剩余额度监控。
- GraphQL 查询越大点成本越高，**不要假设它必然比 REST 省**，关键取法先做 spike 实测。

## 代码规范

- TypeScript strict 必须通过；避免 `any` 与不必要的类型断言；所有外部输入与 LLM 输出用 Zod 校验。
- 共享类型与画像契约只放在 `packages/shared`（含 P2 预留的 `JobPosting`，source+sourceUrl 去重唯一键），全链路复用，禁止各处重复定义。
- 能力/真实性结论必须挂 `evidenceRefs`；**无证据不下结论，证据不足走 `insufficient_data`**。
- 用户可见文案**中英双语并行**（决策 #4 海内外同步，落地即 i18n，见下条），内部标识、代码命名、GitHub 内容用英文。
- **i18n（报告页/UI 落地起执行）**：用户可见字符串一律走 `t()`，先加中文 key 再加同构英文 key，禁止在组件硬编码用户可见文案（仅代码注释、术语数据、输入 placeholder 示例、语言切换器本身可例外）；用一致性测试守护中英文 key 对齐。各前端字典独立（report 与 extension 各一套）；扩展无 URL 语言段，语言取 localStorage 覆盖 + `navigator.languages` 协商，其 MV3 manifest/商店元数据走 Chrome 原生 `_locales`（`__MSG_*__`，目录用 `zh_CN`），详见 docs/design-i18n-20260910.md 第 8 节。
- **设计 token（UI 落地起执行）**：颜色/间距/圆角/阴影用 CSS 变量，禁止散落 `#hex/rgb/hsl` 与硬编码尺寸；不写带 hex fallback 的 `var(--x, #xxx)`。token 单一事实源在 `packages/ui-tokens/tokens.css`（`:root, :host` 双选择器），新前端只消费不另立色板；扩展在 Shadow DOM 内 `:host` 作用域加载，颜色字面量由 tokens-guard 测试守护，详见 docs/design-tokens-20260910.md 第 8 节。
- 未经明确需求不引入新框架/状态库/中间件（尤其不在 MVP 引入 Redis、消息队列、clone 沙箱，见 deferred）。
- 最小权限：新增 GitHub scope、环境变量、对外接口时说明用途。

## 测试与验证

- 测试**就近放置**：`*.test.ts` / `*.test.tsx`，Vitest；E2E 用 Playwright。
- **`analyzer-core` 测试优先级最高**：基于 `tests/fixtures` 脱敏夹具覆盖每条真实性信号，以及"证据不足→`insufficient_data`"分支。
- **默认确定性**：测试不打真实 GitHub、不调真实 LLM，外部响应一律用录制夹具/fake；API/Worker 对夹具做集成测试；Playwright 覆盖"输入用户名→生成→报告→分享"主链路。扩展另有独立 E2E（`pnpm e2e:extension`，配置 `playwright.extension.config.ts`、用例在 `e2e/extension/`）：`launchPersistentContext` + `--headless=new` 加载 unpacked MV3，route 拦截 ATS 页与全部 API，覆盖 content script 注入/Shadow DOM 面板/岗位匹配区块，不连真实 ATS、不打网络。
- 交付前：`pnpm -r typecheck` + 相关测试 + `pnpm -r build` + `git diff --check`，并在汇报中说明验证覆盖与未覆盖项。

## 工程化门禁

- **PR 合并前三件套全绿**：typecheck / build / test；CI 建立后以 PR 上 Actions 为准（含 `pnpm audit --audit-level=high` 依赖审计与 gitleaks 密钥扫描）。
- **gitleaks 配置在仓库根 [.gitleaks.toml](.gitleaks.toml)**：新增 allowlist 必须能说明「被标记的值本身不是凭证」，并按值结构放行（当前仅一条：扩展 manifest `key` 的 RSA 公钥前缀）。两条硬约束——**保留 `[extend] useDefault = true`**（漏写会整体替换默认规则集、等于关闭全部扫描）；**不要用 `paths` 放行整个文件**（CI 用的 gitleaks 8.24.3 不遵守 `condition = "AND"`、会退化成 OR，路径 + 正则等于「该文件内所有 finding 都放行」）。改配置后用 CI 同版本在真实 commit range 上复跑，并植入探针确认真凭证仍会被报出。
- pre-commit（husky）至少跑 `pnpm -r typecheck`；脚手架期补齐 `.husky/pre-commit` 与 `.github/workflows/ci.yml`。

## Commit Message 规范

完整规则以 [git-commit-message.md](git-commit-message.md) 为准，要点：

```text
<type>(<scope>): <imperative English summary>

<English body explaining the purpose>
```

- type：`feat` / `fix` / `refactor` / `chore` / `docs` / `test` / `style` / `perf`
- scope 建议：`analyzer` / `github` / `api` / `worker` / `cli` / `report` / `db` / `docs` / `build`
- subject 为英文祈使句、≤50 字符；每个 commit 必须有简短英文 body 说明目的。
- **原子提交**：一个 commit 只做一件事；文档/配置/测试/功能/修复互不混提。
- 保留作者为用户本人，**不添加 AI co-author**；用户未明确要求时不 push。

### GitHub 内容语言

所有写入 GitHub 的内容必须用英文：Issue/PR 标题与描述、comments、reviews、commit/merge/tag message、Release、Actions 的 workflow/job/step/artifact 名称。本地中文文档、代码注释、面向用户中文文案与中文汇报不受限。

**本仓库不使用 GitHub Issues**：仓库里出现的 `#N` 一律指 **PR 号**或 `docs/deferred-items.md` / handoff 内的条目标号，因此 PR 标题与描述**不得写 `Closes #N` / `Fixes #N`**（会误关联到同名 PR 或指向空）；要指向缓做条目时写成 "resolves the deferred item recorded in `docs/deferred-items.md`"。

## Git 工作流

涉及提交、push、PR、合并、Actions、发布或分支同步时，必须先读并严格执行 [PULL_REQUEST_WORKFLOW.md](PULL_REQUEST_WORKFLOW.md)。本节只定义通用约定。

### 分支职责

| 分支 | 用途 |
| --- | --- |
| `main` | 稳定版本，**只能经 PR 合并**（禁止直接提交） |
| `dev` | 日常开发集成分支：**日常改动直接在此提交并 push**（2026-09-10 起，单人开发不做强制分支） |
| `feature/<描述>`、`fix/<描述>`、`chore/<描述>` | **可选**：需要独立 review / 长生命周期 / 实验性改动时才开，合入后删除 |

- **默认直接在 `dev` 上作业**：提交前 `fetch` + `pull --rebase`，本地三件套通过后再 push。
- `main` 例外：**永远不在 `main` 上直接提交**，只能由 `dev → main` 的真实 PR 合入。
- 需要临时分支时，从最新 `dev` 切出；合并后删除本地与远端临时分支（squash 合并后需 `git branch -D`）。
- 操作任何分支前先 `fetch` 并 `pull --rebase`；工作区不干净时先保护现有改动，不丢弃用户修改。
- rebase/merge/pull 冲突时**立即停止并列出冲突文件，不自动解决**；不对共享分支 force push。
- 不擅自提交/push/PR/合并，只有用户明确要求时才执行。

### PR 描述模板

```markdown
## Summary
- ...

## Scope
- [ ] Analyzer core
- [ ] GitHub source
- [ ] API / Worker
- [ ] Report UI
- [ ] Database / migration
- [ ] Tests
- [ ] Documentation

## Validation
- [ ] `pnpm -r typecheck`
- [ ] `pnpm -r build`
- [ ] `pnpm -r test`
- [ ] `bash tools/check-migrations.sh`
- [ ] `git diff --check`
```

## 安全与秘密

- 不提交 `.env`、`.env.*.local`、GitHub token、用户数据；新增环境变量必须同步 `.env.example`。
- GitHub 访问令牌、未来的 LLM 密钥只存在于服务端环境变量/密钥管理，不进源码、构建产物或 Git 历史。
- 不执行、不 clone 不受信任的仓库代码（MVP 直接不 clone）。
- 不修改/删除与当前任务无关的用户改动与未跟踪文件；不执行破坏性 Git 命令，除非用户明确要求。
