# JobAgent

AI 时代，以代码托管平台（GitHub / Gitee）行为痕迹为"可验证工作证据"的招聘（B 端）+ 应聘（C 端）双向平台。当前 **M1（MVP）核心完成 + 工程化补全完成，P1·Chrome 扩展进入稳定期，P2 职位聚合与画像↔岗位匹配端到端接线完成，Gitee 第二证据源 G-A+G-B 全链路打通，Docker 容器运行时（SQLite + Postgres 双轨）与 GitHub/Gitee/岗位推荐/报告页四条真实端到端均已验证，Worker 弹性增强（not_found 不重试 + 僵尸任务回收）**：pnpm workspaces 全仓（13 workspace）、`packages/shared` 契约（画像 + JobPosting）、`packages/storage` 双方言持久化层、L0/L1 分析链路、报告页 + 分享、浏览器扩展一键填充、五源岗位库与技能匹配均落地，typecheck/test/build/check-migrations 全绿。工程惯例与 `agent-world` 对齐。

## 从哪读起

- **接手/了解进度先读 [handoff.md](handoff.md)**（当前状态 + 活跃待办 + 文档索引）。
- 按场景找文档看 [docs/README.md](docs/README.md)；刻意缓做的事项看 [docs/deferred-items.md](docs/deferred-items.md)。
- 在本仓库写代码前必读 [AGENTS.md](AGENTS.md)（工程约定单一事实源）；参与开发见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 当前阶段

- **M1 完成**：W1 持久化层（SQLite/Postgres 双方言）→ W2 采集+分析内核+CLI → W3 服务化 → W4 报告+分享 → 端到端联调 + 真实性三轮校准（26 账号 0 误报/0 漏报）。MVP 最小闭环：输入 GitHub 或 Gitee 用户名 → L0/L1 分析（不 clone 仓库）→ 产出**可解释、可复核**的能力画像报告。
- **P1 进行中**：Chrome 扩展（MV3，Greenhouse/Lever/Workday 三 ATS 适配 + 一键填充）真实环境冒烟通过，summary→自定义问题映射完成，面板/悬浮球已补齐中英 i18n 与共享设计 token、岗位匹配面板已接线，[试用安装指南](apps/extension/INSTALL.md) 已就绪，待真实用户装扩展试用。
- **P2 完成**：五源岗位库（RemoteOK/Remotive/Greenhouse/Lever/HN）入库与增量同步、纯函数 `matchJobs` 技能匹配、API 岗位搜索/匹配端点、画像↔岗位推荐端到端接线（报告页推荐岛 + 扩展匹配面板）均落地。
- **Gitee 第二证据源完成**：`packages/gitee-source`（v5 REST-only）+ CLI/API/Worker/报告页/扩展全链路平台切换，海内外同步。
- 长期分支：`main`（稳定，只能经 `dev → main` 的 PR 合入）、`dev`（日常集成，**日常改动直接在此提交**）；流程见 [PULL_REQUEST_WORKFLOW.md](PULL_REQUEST_WORKFLOW.md)。

## 文档导航

| 文档 | 作用 |
| --- | --- |
| [docs/PRD.md](docs/PRD.md) | 产品需求：范围、F1–F9、数据契约、指标、风险 |
| [docs/技术选型-MVP-20260910.md](docs/技术选型-MVP-20260910.md) | 技术栈、架构、工程结构与 M1 落地顺序 |
| [docs/待拍板决策清单-20260910.md](docs/待拍板决策清单-20260910.md) | 需产品负责人决策的事项（#1–#8 已拍板，含 #15/#16 追加） |
| [docs/讨论记录-01-切入口与MVP收敛-20260910.md](docs/讨论记录-01-切入口与MVP收敛-20260910.md) | 关键产品判断的讨论过程与依据 |
| [docs/讨论记录-02-投递功能与竞品分析-20260911.md](docs/讨论记录-02-投递功能与竞品分析-20260911.md) | 投递方向、四种技术路径、职位聚合/扩展可行性 |
| [docs/产品构想-以GitHub为桥梁的招聘系统.md](docs/产品构想-以GitHub为桥梁的招聘系统.md) | 最初的产品构想与市场背景 |
| [docs/deferred-items.md](docs/deferred-items.md) | 缓做/低优事项 + 重启触发条件 |
| [docs/市场调研-AI求职赛道-20260910.md](docs/市场调研-AI求职赛道-20260910.md) | AI 求职赛道市场格局、代表性产品画像与跟进建议 |
| [docs/design-i18n-20260910.md](docs/design-i18n-20260910.md) | 用户可见文案双语与 i18n 落地约定 |
| [docs/design-tokens-20260910.md](docs/design-tokens-20260910.md) | 设计 token 体系与禁 hex 约定 |
| [docs/design-storage-dual-dialect-20260911.md](docs/design-storage-dual-dialect-20260911.md) | 持久化层 SQLite/Postgres 双方言适配设计 |
| [docs/设计-职位聚合-Spike-20260913.md](docs/设计-职位聚合-Spike-20260913.md) | P2 职位聚合 Spike：数据源实测结论与最小链路 |
| [docs/design-job-ingestion-20260913.md](docs/design-job-ingestion-20260913.md) | P2 岗位采集管道工程设计（建表/适配器/编排/CLI sync） |
| [docs/design-match-wiring-20260914.md](docs/design-match-wiring-20260914.md) | 画像↔岗位匹配端到端接线设计 |
| [docs/design-gitee-source-spike-20260914.md](docs/design-gitee-source-spike-20260914.md) | Gitee 证据源 Spike：v5 可行性与差异结论 |
| [docs/design-gitee-source-20260914.md](docs/design-gitee-source-20260914.md) | Gitee 第二证据源实现设计（REST 采集/映射/CLI--platform） |
| [docs/design-extension-match-ui-20260914.md](docs/design-extension-match-ui-20260914.md) | 扩展面板岗位匹配 UI 设计 |
| [docs/design-extension-e2e-20260914.md](docs/design-extension-e2e-20260914.md) | 扩展浏览器级 E2E 设计 |
| [docs/API.md](docs/API.md) | HTTP API 接口文档（analyze/jobs/profiles/health） |
| [apps/extension/INSTALL.md](apps/extension/INSTALL.md) | 浏览器扩展试用安装指南（本地服务、Chrome load unpacked、ATS 支持矩阵） |
| [AGENTS.md](AGENTS.md) | AI coding agent 必读卡（工程约定单一事实源） |
| [CONTRIBUTING.md](CONTRIBUTING.md) | 环境、命令、测试、提交与 PR 要求 |
| [MIGRATION_CONVENTION.md](MIGRATION_CONVENTION.md) | 数据库迁移规范（`db/migrations/NNN_*.sql`） |
| [PULL_REQUEST_WORKFLOW.md](PULL_REQUEST_WORKFLOW.md) | dev 直接提交 + `dev → main` PR 的交付流程 |
| [git-commit-message.md](git-commit-message.md) | 原子提交与 Conventional Commits 规范 |
| [handoff.md](handoff.md) | 项目交接主入口（当前状态 / 下一步 / 文档索引） |

## 技术栈（选定方向，详见技术选型文档）

- 语言/运行时：TypeScript（strict、ESM）+ Node.js（版本以 [.nvmrc](.nvmrc) 为准，`nvm use`）
- 工程组织：**pnpm workspaces** monorepo（`packages/*` + `apps/*`，不用 npm/yarn）
- 后端：Hono + Zod；后台分析：独立 Worker（消费 analysis_jobs）
- 数据：**SQLite（本地/实验）+ PostgreSQL（生产）双方言** + Drizzle ORM（方言差异只在 `packages/storage` 内部，业务依赖统一仓储接口）；MVP 不引入 Redis
- 迁移：`db/migrations/{sqlite,postgres}/NNN_verb_snake_case.sql` 对称目录，规范见 [MIGRATION_CONVENTION.md](MIGRATION_CONVENTION.md)
- 采集：GitHub 官方 Octokit（GraphQL 批量优先）；Gitee v5 REST-only（匿名可读，`GITEE_TOKEN` 可选提额）
- 页面：Astro + React islands（落地页为独立 Astro 工程 `bayernjf/job-agent-landing`）
- 扩展：P1 浏览器扩展 `apps/extension`（MV3 + esbuild，三 ATS 适配）
- 测试：Vitest（就近单测）+ Playwright（E2E）

## 开发

```bash
pnpm install                 # 安装依赖
pnpm -r typecheck            # 全仓类型检查
pnpm -r test                 # 全部就近单测（Vitest）
pnpm -r build                # 构建各 workspace
pnpm --filter <pkg> dev      # 只跑某个包/应用
pnpm migrate:up / migrate:down / migrate:status   # SQLite 迁移（migrate:pg:* 走 Postgres）
bash tools/check-migrations.sh   # 校验 sqlite/postgres 迁移目录对齐
```

## Docker 运行

```bash
docker compose up -d                  # SQLite 模式（api:3000, report:4321）
docker compose --profile with-pg up -d # 加 Postgres（端口 5432）
# 环境变量：GITHUB_TOKEN（api/worker）、DB_DRIVER=postgres + DATABASE_URL 切 PG
```

## 当前不可违背的产品/工程规则

- 分析内核（`analyzer-core`）必须是**纯函数、带 analyzerVersion、可复现**，不直接做 I/O。
- **任何结论必须有证据（EvidenceItem）支撑；证据不足输出 `insufficient_data`，不臆断。**
- 真实性用"分级 + 证据信号 + 置信度"，**不输出单一"真实度百分比"**。
- MVP **只走平台公开 API（L0/L1），不 clone、不执行任何仓库代码**；支持 GitHub 与 Gitee 双平台。
- 所有 DB 访问经单一持久化/仓储模块，业务层不写裸 SQL、不感知方言。
- 共享类型与画像契约只放 `packages/shared`（含 P2 预留的 `JobPosting`）。
- 所有写入 GitHub 的内容（commit/PR/Issue/Actions 名称）使用英文；本地中文文档与中文汇报不受限。
