# Handoff

JobAgent 当前状态，截至 2026-09-10。

> 本文件只保留「项目当前状态 + 活跃任务 + 最近变更 + 文档索引」，是接手（人或 AI agent）的第一入口。
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
- [docs/PRD.md](docs/PRD.md) — 产品范围、F1–F9、AbilityProfile/EvidenceItem 契约、指标、风险 ★
- [docs/技术选型-MVP-20260910.md](docs/技术选型-MVP-20260910.md) — 技术栈选型、运行架构、目录规划、M1 排期与 Spike ★
- [docs/市场调研-AI求职赛道-20260910.md](docs/市场调研-AI求职赛道-20260910.md) — AI 求职赛道头部玩家匿名调研：市场格局、功能全景、增长打法、信任风险与 P0/P1/P2 跟进建议（现行）
- [docs/待拍板决策清单-20260910.md](docs/待拍板决策清单-20260910.md) — #1–#14，#1–#8 已拍板（#4 当日修订为海内外同步），#9–#14 延后 ★
- [docs/deferred-items.md](docs/deferred-items.md) — 缓做/低优事项登记表（挂起项 + 触发条件的单一事实源）
- [docs/design-i18n-20260910.md](docs/design-i18n-20260910.md) — i18n 设计：自研 `t()` + 中英 JSON 字典、key 对齐守护、分享链接语言固定、不翻译边界（现行）
- [docs/design-tokens-20260910.md](docs/design-tokens-20260910.md) — 设计 token 设计：`--ja-*` 三层变量体系、组件禁 hex、与落地页 `--lui-*` 互不约束（现行）

## 当前状态

- 阶段：**M1·W1 脚手架已完成**（pnpm workspaces 骨架 + `packages/shared` 契约，typecheck/test/build 全绿），下一步是持久化抽象层与首个迁移。
- 仓库：https://github.com/bayernjf/job-agent （public）；长期分支 `main`、`dev`；截至 `f0de749`，W1 脚手架/契约/CI 修复均已 push，本地 `dev` 与 `origin/dev` 一致、无未推送提交。
- 落地页已上线：https://job-agent.bayjf.com （仓库 `bayernjf/job-agent-landing`，Cloudflare Pages，详见其 handoff）。
- 待办：见上方「活跃待办」（决策 #1–#8 已拍板；迁移 → github-source/analyzer-core/cli → 去风险实验 → 系统层）。

## 活跃待办（下一步）

> 启动前决策 #1–#8 已于 2026-09-10 拍板；M1·W1 骨架与 `packages/shared` 契约已完成（见最近变更）。

1. M1·W1：建持久化抽象层与首个迁移 `db/migrations/001_*.sql`（遵循 MIGRATION_CONVENTION，补 check/down/migrations.test）。
2. M1·W2：`github-source` + `analyzer-core`（纯函数）+ `cli`，先在命令行对真实账号出画像（不起 Web）。
3. M1·W2–W3：用 CLI 跑已拍板的去风险实验（#8 模板，20–50 标注账号，标注人/判定人届时落实），校准真实性信号，**通过后才进 P2 系统层**。
4. M1·W3–W4：Postgres + 仓储层 + `analysis_jobs` + `api`/`worker`；Astro 报告页 + 分享，接通落地页 demo。
5. M1·W4（与第 4 项同批）：报告页落地即执行 [i18n](docs/design-i18n-20260910.md) 与[设计 token](docs/design-tokens-20260910.md)——自研 `t()` + 中英字典 + key 对齐测试、`--ja-*` 变量体系；**落地页 `job-agent-landing` 双语与 token 由负责人自行推进，不在本仓范围**。

> **决策 #4 修订（海内外同步）对后续待办的影响**：报告/界面 P0 起中英双语（i18n `t()`、中英 key 对齐）、部署双区域可访问、合规 GDPR + 个保法双线；证据源仍先 GitHub 跑通内核，Gitee 适配器提前到 M1 末/M2 初（第一个并行 EvidenceSource），不进 M1 最早期。

## 最近变更

- 2026-09-10：**分支策略放宽（单人开发）**——日常改动直接在 `dev` 提交并 push（push 前 `pull --rebase` + 本地三件套），`main` 仍只能经 `dev → main` 真实 PR 合入；临时分支降为可选项。已同步 AGENTS / PULL_REQUEST_WORKFLOW / CONTRIBUTING / README。
- 2026-09-10：新增两份设计文档 —— [i18n](docs/design-i18n-20260910.md)（方案定为自研 `t()` + 中英 JSON 字典 + key 对齐测试，不引框架；分享链接固定语言）与[设计 token](docs/design-tokens-20260910.md)（`--ja-*` 三层变量、组件禁 hex），并在 deferred 登记引 i18n 库 / 双仓 token 统一 / 第三语言等触发条件。落地页双语与 token 由负责人自行推进，不纳入本仓。
- 2026-09-10：决策 **#4 由"先海外"修订为"海内外同步"**（P0 中英双语、双区域、合规双线；Gitee 提前为 GitHub 内核验证后的首个并行证据源）；PRD 升 v0.2（回灌 #1–#8 决策与市场调研结论、清除过时"待决策"标记、补"不做自动投递/表单填充"边界），同步决策清单/deferred。
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

- 当前工作分支：`dev`（track `origin/dev`）；M1·W1 脚手架提交已推送，本地领先提交以 `git log origin/dev..dev` 为准。
- 不直接在 `main`/`dev` 上开发新功能；后续工作从最新 `dev` 切 `feature/*` 分支并经 PR 合入（见 PULL_REQUEST_WORKFLOW.md）。
