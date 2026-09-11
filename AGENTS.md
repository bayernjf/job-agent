# AGENTS.md — JobAgent 项目指令

本文档供在本仓库工作的 AI coding agents 使用。**修改代码或文档前应先通读本文件**，并保持本文档与项目实际状态同步。本文件是项目工程约定的单一事实源；`CLAUDE.md` 只引用本文件。工程惯例与 `agent-world` 对齐。

## 0. 任务追踪与文档分层（接手先读 handoff）

- **[handoff.md](handoff.md) 是任务追踪主入口**：当前状态 + 活跃待办 + 最近变更 + 「Project documents」文档索引。任何 agent 接手先读它。
- **全文设计放 [docs/](docs/)**：一个主题一份文档（产品、技术选型、design-*），设计文档只写设计，不重复记流水进度。
- **缓做事项放 [docs/deferred-items.md](docs/deferred-items.md)**：每条必须带**触发条件**；触发后移回 handoff 待办并标「已重启日期」。
- **[docs/README.md](docs/README.md)** 是"我想做 X 该看哪个"的场景导航，不重复维护清单（清单以 handoff 为准）。
- **新增任何文档后**：在 handoff「Project documents」登记一行（含一句话定位），并在 docs/README 补场景入口。
- 文档状态：现行 / 历史 / 归档；实施进度统一记 handoff。

## 项目概览

JobAgent 把开发者的 GitHub 行为痕迹（commit / PR / Issue / 项目演进）分析为**可信、可解释、可复核**的能力画像，服务于技术招聘与应聘。当前为 MVP（M1）准备阶段：产品/技术文档已完成，代码骨架待初始化。

- 包管理器：**pnpm workspaces**（`pnpm-workspace.yaml`，不使用 npm/yarn，避免多套 lockfile）
- Node 版本以 **[.nvmrc](.nvmrc)** 为准（`nvm use`）；语言 TypeScript（**strict**、ESM）
- 后端：Hono + Zod；分析任务由独立 Worker 消费
- 数据库：PostgreSQL + Drizzle ORM（**Drizzle 仅在持久化模块内部用**，见下；MVP 不引入 Redis）
- GitHub 采集：官方 Octokit，GraphQL 批量优先、REST 补；生产用 GitHub App
- 页面：Astro + React islands；落地页是独立工程 `../job-agent-landing`
- 测试：Vitest（就近单元）+ Playwright（E2E）
- 分析深度：MVP 仅 **L0 元数据 + L1 行为时序**，**不 clone 仓库**（L2/L3/L4 见 docs/deferred-items）

> 选型理由、备选方案与待核实项见 [docs/技术选型-MVP-20260910.md](docs/技术选型-MVP-20260910.md)；产品范围以 [docs/PRD.md](docs/PRD.md) 为准；未拍板事项见 [docs/待拍板决策清单-20260910.md](docs/待拍板决策清单-20260910.md)，**不得把"建议"当作"已决策"直接实现**。

## 项目结构（已按技术选型文档第 7 章落地，2026-09-10 脚手架）

```text
job-agent/
├─ packages/
│  ├─ shared/         # AbilityProfile/EvidenceItem 类型 + Zod 契约（单一事实源）
│  ├─ storage/        # 持久化抽象层：仓储接口（统一 async）+ entities 共享 + sqlite/postgres 双实现 + 迁移器（业务模块禁裸 SQL；设计见 docs/design-storage-dual-dialect-20260911.md）
│  ├─ github-source/  # Octokit、GraphQL 查询、L0/L1 采集、限频/缓存（首个 EvidenceSource）
│  ├─ analyzer-core/  # 纯函数：行为信号→真实性分级→能力标签→画像装配；规则版本化
│  └─ llm/            # LLM 端口 + 结构化输出校验（P1 才启用，见 deferred）
├─ apps/
│  ├─ api/            # Hono：触发分析、查询任务/画像、只读分享接口
│  ├─ worker/         # 消费 analysis_jobs，调用 github-source + analyzer-core
│  ├─ cli/            # 本地批量分析，导出 JSONL/报告（供决策 #8 标注实验）
│  └─ report/         # Astro 报告页 + React islands
├─ db/migrations/sqlite/   # SQLite 编号迁移（NNN_verb_snake_case.sql）
├─ db/migrations/postgres/ # Postgres 编号迁移（与 sqlite 编号/文件名一一对应），规范见 MIGRATION_CONVENTION.md
├─ tools/             # check-migrations.sh 等只读工程脚本
├─ tests/fixtures/    # 录制并脱敏的 GitHub 响应夹具
└─ docs/              # 产品/技术全文（PRD、技术选型、决策清单、讨论、deferred）
```

> 结构已于 2026-09-10 脚手架落地，M1·W1 完成 `packages/shared`（Zod 契约）与 `packages/storage`（持久化层 + `db/migrations/001`）；`github-source`/`analyzer-core`/`cli` 等为占位包，后续里程碑按各包注释填充。

## 常用命令

```bash
pnpm install                 # 安装依赖
pnpm -r typecheck            # 全仓类型检查，不产出文件
pnpm -r test                 # 全部就近单测（Vitest）
pnpm -r build                # 构建各 workspace
pnpm --filter <pkg> dev      # 只跑某个包/应用
pnpm --filter <pkg> exec vitest run path/to/file.test.ts  # 跑单个测试文件
pnpm migrate:up / migrate:down / migrate:status          # 应用/回滚一步/查看迁移（默认 data/job-agent.db）
bash tools/check-migrations.sh   # 只读校验迁移命名/编号/文件头
```

提交或交付前至少完成：typecheck、相关单测、build、迁移校验、`git diff --check`。

## 运行架构（分析管道）

1. 接口收到用户名 → Zod 校验 → 命中未过期画像快照则直接返回。
2. 否则创建 `analysis_jobs(queued)`，API 立即返回 `jobId`。
3. Worker 认领：`github-source` 先取 **L0** 写一版 `partial:L0` 轻画像，再补 **L1** 行为时序。
4. `analyzer-core`（**纯函数、带版本、无 I/O**）计算真实性信号、能力标签、规则化面试题，产出完整 `AbilityProfile`。
5. 画像以**不可变快照**写入 `profiles`，证据写入 `evidence`；分享链接永远指向生成时版本。
6. 任一层失败必须显式标注缺失，**禁止输出"看似完整"的报告**。

### 内核与 I/O 分离（硬约束）

- `analyzer-core` 不发请求、不读数据库、不读文件系统；输入是采集后的结构化数据，输出是画像，便于对固定夹具做单测。
- `github-source` 是第一个 `EvidenceSource`；未来 Gitee / 作品集以同接口新增，内核不改。

## 数据访问抽象层与迁移

### 所有 DB 访问收敛到单一持久化模块（硬约束，对齐 agent-world）

- 设唯一持久化/仓储抽象（如各服务内的 `db.ts` / repository），对外只暴露 `getX/insertX/listX` 等方法；**业务模块内禁止裸 SQL、禁止直接调用驱动/Drizzle 查询**。
- **SQL 方言差异只允许出现在该模块内部**（W3-6 起落地 Postgres/SQLite 双轨：业务只依赖统一 async 仓储接口与 `createStorage()` 工厂，按 `DB_DRIVER` 切换，见 [docs/design-storage-dual-dialect-20260911.md](docs/design-storage-dual-dialect-20260911.md)）；Drizzle 只在这层内部做类型化查询，调用方不感知。
- 数据库字段 `snake_case`，TS 字段 `camelCase`，转换集中在数据访问层。

### 迁移规范

- 结构变更只通过 **`db/migrations/{sqlite,postgres}/NNN_verb_snake_case.sql`** 编号文件（两侧各一份、编号文件名对齐），规则（文件头、幂等、`COMMENT ON`、只追加不重写、回滚）见 [MIGRATION_CONVENTION.md](MIGRATION_CONVENTION.md)。
- W1 已落地：迁移器（按序应用）、`scripts/migrate-down`（回滚一步，无安全 down 则拒绝）、`migrations.test.ts`（干净库顺序加载/编号连续/关键表存在），实现见 `packages/storage`。
- M1 核心表：`profiles`（画像快照 JSONB + analyzerVersion + 时间窗）、`evidence`、`analysis_jobs`、`waitlist`；账号/认领头表 P1 再加（见 deferred）。
- 画像存**快照**而非实时重算，避免源数据变化导致已分享结论漂移；优先存**证据指针与精简原始快照（带 ETag）**，不做无标注全量拷贝。

## GitHub 采集与外部约束

- 只用官方 **Octokit**，启用 throttling / retry 插件处理次级限频；**凭证只在服务端，绝不下发前端、不入 Git**。
- 限额以 GitHub 官方文档当期值为准（技术选型文档记录了 2026-09-10 核实值）：REST 认证约 5,000 次/小时、GraphQL 按"点"计约 5,000 点/小时，GitHub App 额度更高；开工前需复核非企业 GitHub App 精确值。
- 必须实现：单画像调用预算、ETag 条件请求、缓存优先、限频退避、剩余额度监控。
- GraphQL 查询越大点成本越高，**不要假设它必然比 REST 省**，关键取法先做 spike 实测。

## 代码规范

- TypeScript strict 必须通过；避免 `any` 与不必要的类型断言；所有外部输入与 LLM 输出用 Zod 校验。
- 共享类型与画像契约只放在 `packages/shared`，全链路复用，禁止各处重复定义。
- 能力/真实性结论必须挂 `evidenceRefs`；**无证据不下结论，证据不足走 `insufficient_data`**。
- 用户可见文案**中英双语并行**（决策 #4 海内外同步，落地即 i18n，见下条），内部标识、代码命名、GitHub 内容用英文。
- **i18n（报告页/UI 落地起执行）**：用户可见字符串一律走 `t()`，先加中文 key 再加同构英文 key，禁止在组件硬编码用户可见文案（仅代码注释、术语数据、输入 placeholder 示例、语言切换器本身可例外）；用一致性测试守护中英文 key 对齐。
- **设计 token（UI 落地起执行）**：颜色/间距/圆角/阴影用 CSS 变量，禁止散落 `#hex/rgb/hsl` 与硬编码尺寸；不写带 hex fallback 的 `var(--x, #xxx)`。
- 未经明确需求不引入新框架/状态库/中间件（尤其不在 MVP 引入 Redis、消息队列、clone 沙箱，见 deferred）。
- 最小权限：新增 GitHub scope、环境变量、对外接口时说明用途。

## 测试与验证

- 测试**就近放置**：`*.test.ts` / `*.test.tsx`，Vitest；E2E 用 Playwright。
- **`analyzer-core` 测试优先级最高**：基于 `tests/fixtures` 脱敏夹具覆盖每条真实性信号，以及"证据不足→`insufficient_data`"分支。
- **默认确定性**：测试不打真实 GitHub、不调真实 LLM，外部响应一律用录制夹具/fake；API/Worker 对夹具做集成测试；Playwright 覆盖"输入用户名→生成→报告→分享"主链路。
- 交付前：`pnpm -r typecheck` + 相关测试 + `pnpm -r build` + `git diff --check`，并在汇报中说明验证覆盖与未覆盖项。

## 工程化门禁

- **PR 合并前三件套全绿**：typecheck / build / test；CI 建立后以 PR 上 Actions 为准（含 `pnpm audit --audit-level=high` 依赖审计与 gitleaks 密钥扫描）。
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
