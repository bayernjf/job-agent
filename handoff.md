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
- [docs/待拍板决策清单-20260910.md](docs/待拍板决策清单-20260910.md) — #1–#14，#1–#4 为启动前阻塞项（尚未拍板）★
- [docs/deferred-items.md](docs/deferred-items.md) — 缓做/低优事项登记表（挂起项 + 触发条件的单一事实源）

## 当前状态

- 阶段：**产品定义完成、工程代码未起步**的 MVP（M1）准备期。MVP 只做 L0/L1（纯 API、不 clone）的单账号可信能力画像。
- 仓库：https://github.com/bayernjf/job-agent （public）；长期分支 `main`、`dev`，已推送的初始提交含 5 份产品文档。
- 工程约定文档（README/AGENTS/CONTRIBUTING/handoff/迁移规范/PR 流程等）与本次 `agent-world` 对齐改动**均在工作区、尚未提交**（遵循"未明确要求不提交/push"）。
- 尚无任何代码、`package.json`、CI。

## 活跃待办（下一步）

1. **等拍板 #1–#4**（启动前阻塞）：第一界面 B/C、真实性呈现形态、MVP 深度、首个市场；见决策清单。
2. M1·W1：搭 **pnpm workspaces** 骨架（`packages/*` + `apps/*`、`.nvmrc`、tsconfig.base、husky、CI 三件套），把 PRD 第 8 章落成 `packages/shared` 的 TS 类型 + Zod。
3. M1·W1：建持久化抽象层与首个迁移 `db/migrations/001_*.sql`（遵循 MIGRATION_CONVENTION，补 check/down/migrations.test）。
4. M1·W2：`github-source` + `analyzer-core`（纯函数）+ `cli`，先在命令行对真实账号出画像（不起 Web）。
5. M1·W2–W3：用 CLI 跑决策 #8 的 20–50 标注账号实验，校准真实性信号，**通过后才进 P2 系统层**。
6. M1·W3–W4：Postgres + 仓储层 + `analysis_jobs` + `api`/`worker`；Astro 报告页 + 分享，接通落地页 demo。

## 最近变更

- 2026-09-10：以 `agent-world` 为基准对齐工程惯例——文档分层（handoff 索引 / docs 全文 / deferred 带触发条件 / docs 场景导航）、pnpm workspace + `.nvmrc`、数据访问收敛单一持久化层、`db/migrations` 迁移规范与 `tools/check-migrations.sh`、新增 CONTRIBUTING；5 份产品文档移入 `docs/`，移除 docs/superpowers。
- 2026-09-10：参照 tab-manager 建立 README/AGENTS/CLAUDE/PR 流程/commit 规范（后被 agent-world 对齐版取代/增强）。
- 2026-09-10：产出 PRD、技术选型、待拍板决策清单、讨论记录，并推送 main/dev 初始提交。

## 已知限制 / 待核实

- #1–#4 启动前决策仍未拍板；不得把"助手建议"当作"已决策"实现。
- GitHub API 限额为 2026-09-10 官方文档核实值，开工前需复核非企业 GitHub App 精确额度（来源见技术选型文档）。
- 托管价格、LLM 厂商/单价待当期 spike；本机访问 GitHub 直连不稳定（全局代理 127.0.0.1:7897 常未开启，需临时直连重试，勿改全局配置）。

## Git 状态

- 当前工作分支：`dev`（track `origin/dev`）。
- 工作区：产品文档移动已 `git mv`（暂存为重命名），其余约定/对齐文档为未跟踪或已修改；**待用户明确要求后**再按 PULL_REQUEST_WORKFLOW 做原子提交、推送与 PR。
