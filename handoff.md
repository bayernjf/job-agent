# Handoff

JobAgent 当前状态，截至 2026-09-11。

> 本文件只保留「项目当前状态 + 活跃任务 + 最近变更 + 文档索引」，是接手（人或 AI agent）的第一入口；**只写状态与结论，明细一律放进对应文档并在此给链接，不在本文件展开**。
> 设计/结论全文放 [docs/](docs/)；缓做事项放 [docs/deferred-items.md](docs/deferred-items.md)；场景化导航见 [docs/README.md](docs/README.md)。

## Project documents

📚 **文档地图（按场景怎么读 + 状态约定）**：[docs/README.md](docs/README.md)。以下为全部文档直达（本区是完整清单的单一事实源，docs/README 只做场景导航、不重复清单）：

- [README.md](README.md) — 项目门面、技术栈、规划命令、铁律
- [AGENTS.md](AGENTS.md) — AI coding agent 工程约定单一事实源（CLAUDE.md 仅引用它）
- [CONTRIBUTING.md](CONTRIBUTING.md) — 本地开发 / 测试 / 提交 / PR 统一要求
- [MIGRATION_CONVENTION.md](MIGRATION_CONVENTION.md) — 数据库迁移命名/文件头/幂等/回滚规范
- [git-commit-message.md](git-commit-message.md) — 英文原子 Conventional Commits 规范
- [PULL_REQUEST_WORKFLOW.md](PULL_REQUEST_WORKFLOW.md) — 分支职责、PR 评审与合并流程
- [docs/产品构想-以GitHub为桥梁的招聘系统.md](docs/产品构想-以GitHub为桥梁的招聘系统.md) — 原始构想：定位、市场、B/C 双向闭环（历史）
- [docs/讨论记录-01-切入口与MVP收敛-20260910.md](docs/讨论记录-01-切入口与MVP收敛-20260910.md) — 切入口、护城河、L0–L4 分层、MVP 收敛过程（历史）
- [docs/讨论记录-02-投递功能与竞品分析-20260911.md](docs/讨论记录-02-投递功能与竞品分析-20260911.md) — 投递功能方向、Jobright 深度竞品分析、四种技术路径对比、职位聚合/Chrome 扩展可行性、3 项待拍板决策（历史）
- [docs/PRD.md](docs/PRD.md) — 产品范围、F1–F9、AbilityProfile/EvidenceItem 契约、指标、风险 ★
- [docs/技术选型-MVP-20260910.md](docs/技术选型-MVP-20260910.md) — 技术栈选型、运行架构、目录规划、M1 排期与 Spike ★
- [docs/市场调研-AI求职赛道-20260910.md](docs/市场调研-AI求职赛道-20260910.md) — AI 求职赛道市场调研：市场格局、功能全景、代表性产品画像、信任风险与 P0/P1/P2 跟进建议（现行）
- [docs/待拍板决策清单-20260910.md](docs/待拍板决策清单-20260910.md) — #1–#14；#1–#8 已拍板（#4 当日修订为海内外同步），#9–#14 延后 ★
- [docs/deferred-items.md](docs/deferred-items.md) — 缓做/低优事项登记表（挂起项 + 触发条件的单一事实源）
- [docs/design-i18n-20260910.md](docs/design-i18n-20260910.md) — i18n 设计：自研 `t()` + 中英 JSON 字典、key 对齐守护、分享链接语言固定、不翻译边界（现行）
- [docs/design-tokens-20260910.md](docs/design-tokens-20260910.md) — 设计 token 设计：`--ja-*` 三层变量体系、组件禁 hex、与落地页 `--lui-*` 互不约束（现行）

## 当前状态

- 阶段：**M1·W3 服务化进行中**（W3-1 analysis_jobs 表+仓储已完成，typecheck/test/build/check-migrations 全绿；下一步 W3-2 worker 核心逻辑）。M1·W2 代码交付已完成（`github-source` + `analyzer-core` + `cli`，真实账号冒烟通过），#8 去风险实验待 GITHUB_TOKEN。
- 仓库：https://github.com/bayernjf/job-agent （public）；长期分支 `main`、`dev`；脚手架、CI 修复（`e7730fe`）、调研文档、PRD v0.2/双市场与 M1·W1 持久化层（`73f5172`/`86f6d86`/`946c25c`/`2cb8842`）均已 push 至 `origin/dev`，本地与远端一致。
- 落地页已上线：https://job-agent.bayjf.com （仓库 `bayernjf/job-agent-landing`，Cloudflare Pages，详见其 handoff）。
- 待办：见上方「活跃待办」（决策 #1–#8 已拍板；迁移 → github-source/analyzer-core/cli → 去风险实验 spike+修复 → 重新批量验证 → 系统层）。

## 活跃待办（下一步）

> 启动前决策 #1–#8 已于 2026-09-10 拍板；M1·W1（骨架、`packages/shared` 契约、持久化层与首个迁移）已完成（见最近变更）。

1. ~~M1·W1：建持久化抽象层与首个迁移 `db/migrations/001_*.sql`（遵循 MIGRATION_CONVENTION，补 check/down/migrations.test）。~~ ✅ 已完成（2026-09-11）
2. ~~M1·W2：`github-source` + `analyzer-core`（纯函数）+ `cli`，先在命令行对真实账号出画像（不起 Web）。~~ ✅ 已完成（2026-09-11，见最近变更）
3. ~~#8 去风险实验·S1/S2 spike：5 个真实账号批量跑，暴露 3 个 bug（org 仓库 owner 穿透致 L1 404 / 空仓库 pushedAt=null 崩溃 / 组织账号 NOT_FOUND 未归一）~~ ✅ 已完成（2026-09-11）
4. ~~修复 spike 暴露的 3 个 bug + 回归测试（commit `b77ec11`，18 files）~~ ✅ 已完成（2026-09-11）
5. **#8 去风险实验·重新批量验证（进行中，待 GITHUB_TOKEN）**：bug 修复已完成（commit `b77ec11`），需设置 `GITHUB_TOKEN` 后用修复后 CLI 重跑 5 个账号（建议：torvalds / 2 位 OSS 维护者 / github 组织账号 / 1 个普通账号）确认无崩溃、证据链对齐；通过后扩到 20–50 标注账号（标注人/判定人届时落实），校准真实性信号，**通过后才进 P2 系统层**。
6. **M1·W3 服务化**（进行中）：
   - ~~W3-1：`analysis_jobs` 表迁移(002) + schema + AnalysisJobsRepository（create/claimNext/updateStage/succeed/fail/listBySubject/latestActiveBySubject/listQueued/countByStatus）+ 12 测试~~ ✅ 已完成（2026-09-11）
   - ~~W3-2：worker 核心逻辑——轮询认领 job → 调 github-source(L0→L1) → 调 analyzer-core → 写 profiles → 更新 job 状态（succeeded/failed），失败重试上限 3 次~~ ✅ 已完成（2026-09-11）
   - ~~W3-3：api Hono 接口——POST /analyze（创建 job，去重：同一用户有 active job 则返回现有 jobId）、GET /jobs/:id（查询状态）、GET /profiles/:id（查询画像快照）~~ ✅ 已完成（2026-09-11）
   - ~~W3-4：evidence 表迁移(003) + schema + 仓储（证据索引，关联 profile_id）~~ ✅ 已完成（2026-09-11）
   - ~~W3-5：waitlist 表迁移(004) + schema + 仓储（落地页留资）~~ ✅ 已完成（2026-09-11）
   - W3-6：Postgres 方言适配（storage 双轨：SQLite 本地/实验 + Postgres 生产，Drizzle 方言隔离）
7. **M1·W4 报告与分享**：Astro 报告页 + React islands + 只读分享链接 + 接落地页 demo（落地即执行 i18n 与设计 token）。

8. **P1·Chrome 扩展一键填充**（决策 #15，2026-09-11 拍板）：画像验证通过后启动，支持 Workday/Greenhouse/Lever 三大 ATS，填充数据来自可信画像；只做用户主动触发的一键填充，不做全自动后台投递。前置：packages/shared 预留可导出画像数据结构。
9. **P2·职位聚合（岗位搜集）**（决策 #16，2026-09-11 拍板）：按原计划 P2 启动，先聚焦海外技术岗数据源（Wellfound/YC Jobs/RemoteOK 等），轻量爬虫+公开 API，日更增量；是匹配/投递的前置基础设施。当前只做准备：JobPosting 类型预留 + 1-2 天 Spike 验证。

> **决策 #4 修订为"海内外同步"**：双语、双区域部署、合规双线与 Gitee 节奏的影响见 [待拍板决策清单 #4](docs/待拍板决策清单-20260910.md) 与 [PRD NFR-8](docs/PRD.md)。

## 最近变更

- 2026-09-11：**M1·W3-4 evidence 表 + W3-5 waitlist 表落地**——新增 `db/migrations/003_create_evidence.sql`（evidence 表：id/profile_id/source_platform/source_type/url/occurred_at/layer/claim/raw_ref/created_at，两个索引，含 down 段）和 `db/migrations/004_create_waitlist.sql`（waitlist 表：id/email(UNIQUE)/name/github_username/source/status/notes/created_at/updated_at，两个索引，含 down 段）；`packages/storage/src/schema.ts` 新增 evidence 和 waitlist Drizzle 表定义；`packages/storage/src/evidence.ts` 实现 EvidenceRepository（insert/insertBatch/importFromProfile/getById/listByProfile/listBySource/countByProfile）；`packages/storage/src/waitlist.ts` 实现 WaitlistRepository（insert/getById/getByEmail/listByStatus/listAll/updateStatus/updateNotes/countByStatus，email 唯一去重，状态机 pending→contacted→converted/archived）；storage index.ts 新增导出；migrations.test.ts 适配 003/004（四步回滚验证）；evidence 8 测试 + waitlist 9 测试；全仓 typecheck/build 全绿，storage 39 测试全绿，check-migrations 通过。

- 2026-09-11：**M1·W3-3 API Hono 接口落地**——`apps/api/src/index.ts` 实现完整 REST API：POST /analyze（Zod 校验 username，去重：同一用户有 active queued/running 任务则返回现有 jobId，否则创建新任务返回 201）、GET /jobs/:id（查询任务状态含 stage/attempts/profileId/error/budget/missing/时间戳）、GET /profiles/:id（查询完整画像快照）、GET /health（健康检查）、404 兜底、全局错误处理、CORS 开放（MVP 阶段）；createApp 可注入仓储便于测试，initRepos 初始化数据库+迁移+仓储；api package.json 添加 hono、@hono/node-server、zod、@jobagent/storage、better-sqlite3、drizzle-orm 依赖；13 个集成测试覆盖 /analyze 成功/去重/非活跃后新建/空 username/无效格式/非 JSON body、/jobs 查询/状态流转/404、/profiles 查询/404、/health、404 兜底；全仓 typecheck/build 全绿，api 13 测试全绿。

- 2026-09-11：**M1·W3-2 worker 核心逻辑落地**——`apps/worker/src/index.ts` 实现完整 Worker：initRepos（数据库连接+迁移+仓储）、processJob（采集→更新 stage→分析→写画像→标记成功，纯逻辑可单测）、handleJobFailure（attempts<maxRetries 时 resetToQueued 重试，否则永久 failed）、runWorker（主循环：claimNext 原子认领→processJob→成功/失败处理，无任务时 sleep，支持优雅关闭 SIGINT/SIGTERM）；AnalysisJobsRepository 新增 resetToQueued 方法（失败重试时重置状态，保留 attempts 计数，清空 stage/startedAt/finishedAt/claimedBy）；worker package.json 添加 @jobagent/storage、@jobagent/github-source、@jobagent/analyzer-core、better-sqlite3、drizzle-orm 依赖；10 个测试覆盖 processJob 成功/失败/缺失层、handleJobFailure 重试/永久失败/重试后可再认领、runWorker 主循环/失败重试/空轮询 sleep；全仓 typecheck/build 全绿，worker 10 测试全绿。

- 2026-09-11：**M1·W3-1 analysis_jobs 表+仓储落地**——新增 `db/migrations/002_create_analysis_jobs.sql`（analysis_jobs 表：id/subject_platform/subject_login/status/stage/attempts/profile_id/error_message/budget_used/missing/claimed_by/created_at/updated_at/started_at/finished_at，两个索引，含 down 段）；`packages/storage/src/schema.ts` 新增 analysisJobs Drizzle 表定义；`packages/storage/src/analysis-jobs.ts` 实现 AnalysisJobsRepository（create/getById/claimNext/updateStage/succeed/fail/listBySubject/latestActiveBySubject/listQueued/countByStatus），claimNext 用事务内两步法（SELECT 最老 queued id → UPDATE 特定 id + status 双重校验）保证原子认领只更新一行，attempts<3 防无限重试；12 个测试覆盖全方法 + 迁移列检查；migrations.test.ts 适配 002（分两步回滚验证）；全仓 typecheck/build 全绿，storage 22 测试全绿，check-migrations 通过。

- 2026-09-11：**#8 去风险实验 spike + bug 修复**——5 个真实账号批量跑暴露 3 个 bug：①`user.repositories` 含组织仓库（节点 name='vitest' 但真实 owner 是 vitest-dev），L1 用 owner=本人 login 查 commits 必然 404；②空仓库 `pushedAt=null` 致 `.slice()`/`localeCompare` 崩溃；③组织账号 user 查询返回 NOT_FOUND 未归一为 not_found。修复贯穿 analyzer-core（新增 `ownerLogin` 契约 + `repoRef()` 统一证据引用 + null 安全排序/过滤）与 github-source（真实 owner 贯穿 L0→L1 + NOT_FOUND 归一化 + 证据构造）；新增 3 个回归测试（org owner 穿透、null pushedAt、org NOT_FOUND），更新全部 4 个 L0 夹具补 nameWithOwner/owner；commit `b77ec11`，typecheck/test/build/check-migrations 全绿。

- 2026-09-11：**M1·W2 交付**——`github-source`（Octokit + 限频/重试 + 单画像预算 + ETag 缓存 + L0/L1 采集）、`analyzer-core`（纯函数内核：四态真实性 + 置信度、技能标签、资历提示、模板面试题）、`cli`（analyze/batch，JSONL 输出）；4 个原子提交 `c663594`/`d1585f2`/`ccda43f`/`01c26c6`，53 测试全绿，真实账号 bayernjf 冒烟通过（likely_authentic 0.72）。真实冒烟校准两点：①GraphQL 响应无 `x-ratelimit-cost` 头，预算改为每次至少记 1 点；②仅 email 不一致降级 warn（noreply 常见），email+name 双重不一致才 risk，避免强工程师误判可疑。
- 2026-09-11：M1·W1 持久化层等 4 个提交已 push 至 `origin/dev`；`fix(storage)` 排除测试文件出构建产物（`tsconfig.build.json` + vitest exclude `dist/`），修复 vitest 双跑问题（20 → 10）。
- 2026-09-11：M1·W1 持久化层落地——`packages/storage`（Drizzle + better-sqlite3：迁移器/回滚、profiles 仓储、CLI `migrate up/down/status`）、`db/migrations/001_create_profiles.sql`（含 down 段）、`scripts/migrate-down`、根 `migrate:*` 命令与 `data/` 忽略；typecheck/test/build/check-migrations 全绿，CLI 冒烟通过。
- 2026-09-11：市场调研文档定稿并落库（`docs/市场调研-AI求职赛道-20260910.md`，经多轮脱敏：量级口径、去头部点名、删纯商业描述），docs/README 补入口。
- 2026-09-10：分支策略放宽为「日常改动直接在 `dev` 提交，`main` 仍需 PR」，已同步 AGENTS / PULL_REQUEST_WORKFLOW / CONTRIBUTING / README（细节见 [PULL_REQUEST_WORKFLOW.md](PULL_REQUEST_WORKFLOW.md)）。
- 2026-09-10：新增 [i18n](docs/design-i18n-20260910.md) 与[设计 token](docs/design-tokens-20260910.md) 两份设计文档，后续项已登记 [deferred](docs/deferred-items.md)；落地页双语/token 由负责人自行推进，不纳入本仓。
- 2026-09-10：决策 **#4 修订为"海内外同步"**，PRD 升 v0.2 回灌 #1–#8 决策与市场边界（细节见 [待拍板决策清单](docs/待拍板决策清单-20260910.md) 与 [PRD](docs/PRD.md)）。
- 2026-09-10：M1·W1 脚手架落地——pnpm workspaces 根（package.json / tsconfig.base / .gitignore / husky pre-commit / CI 三件套）、`packages/shared` 落成 PRD 第 8 章 Zod 契约（7 测试通过）、7 个占位包；typecheck/test/build 全绿。启动前决策 #1–#8 拍板（采纳助手推荐组合）。
- 2026-09-10：工程约定文档提交并合入 `main`（PR #1），`dev` 与 `main` 同步；落地页 `job-agent-landing` 完成 Cloudflare Pages 部署上线（https://job-agent.bayjf.com，含构建时预览截图管线）。
- 2026-09-10：以 `agent-world` 为基准对齐工程惯例——文档分层（handoff 索引 / docs 全文 / deferred 带触发条件 / docs 场景导航）、pnpm workspace + `.nvmrc`、数据访问收敛单一持久化层、`db/migrations` 迁移规范与 `tools/check-migrations.sh`、新增 CONTRIBUTING；5 份产品文档移入 `docs/`，移除 docs/superpowers。
- 2026-09-10：参照 tab-manager 建立 README/AGENTS/CLAUDE/PR 流程/commit 规范（后被 agent-world 对齐版取代/增强）。
- 2026-09-10：产出 PRD、技术选型、待拍板决策清单、讨论记录，并推送 main/dev 初始提交。

## 已知限制 / 待核实

- 启动前决策 #1–#8 已于 2026-09-10 拍板；#9–#14 保持延后（见待拍板决策清单），不得把"助手建议"当作"已决策"实现。
- GitHub API 限额为 2026-09-10 官方文档核实值，开工前需复核非企业 GitHub App 精确额度（来源见技术选型文档）。
- 托管价格、LLM 厂商/单价待当期 spike；本机访问 GitHub 直连不稳定（全局代理 127.0.0.1:7897 常未开启，需临时直连重试，勿改全局配置）。

## Git 状态

- 当前工作分支：`dev`（track `origin/dev`）；分支策略：日常改动直接在 `dev` 提交，`main` 仍需 PR（细节见 [PULL_REQUEST_WORKFLOW.md](PULL_REQUEST_WORKFLOW.md)）。
