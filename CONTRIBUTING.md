# Contributing — JobAgent

感谢参与 JobAgent。本文说明本地开发、测试、提交与 PR 的统一要求；AI coding agents 另以 [AGENTS.md](AGENTS.md) 为单一事实源。

## 1. 环境准备

- **Node.js**：版本以 [.nvmrc](.nvmrc) 为准（与 agent-world 对齐）。用 nvm/fnm 切换：`nvm use`。
- **包管理器：pnpm**（monorepo，workspace 见 [pnpm-workspace.yaml](pnpm-workspace.yaml)）。未启用时：`corepack enable && corepack prepare pnpm@latest --activate`。
- 不使用 npm/yarn 安装依赖，避免产生多套 lockfile。

```bash
pnpm install        # 安装全部 workspace 依赖
```

## 2. 常用命令

```bash
pnpm -r typecheck   # 全仓类型检查（不产出文件）
pnpm -r test        # 全部单元测试（Vitest，就近 *.test.ts）
pnpm -r build       # 构建各 workspace
pnpm migrate:up / migrate:down / migrate:status   # 应用/回滚一步/查看迁移（默认 data/job-agent.db）
pnpm --filter <pkg> dev   # 只跑某个包/应用
pnpm --filter <pkg> test  # 只跑某个包的测试
```

> 迁移命令依赖 `packages/storage` 已 build（`pnpm -r build` 或包内 `pnpm build`）。

## 3. workspace 布局

`packages/*`（shared / github-source / analyzer-core / llm）与 `apps/*`（api / worker / cli / report）。规划细节见 [AGENTS.md](AGENTS.md) 与 [docs/技术选型-MVP-20260910.md](docs/技术选型-MVP-20260910.md)。

## 4. 测试约定

- 测试文件就近放置：`*.test.ts` / `*.test.tsx`，使用 Vitest；E2E 用 Playwright。
- **默认使用录制并脱敏的 GitHub 响应夹具 / 确定性 fake，不打真实 GitHub、不调真实 LLM**；外部依赖一律可离线复现。
- `analyzer-core` 是纯函数内核，测试优先级最高：每条真实性信号、以及"证据不足 → `insufficient_data`"分支都要有夹具覆盖。
- 跑单个测试文件：`pnpm --filter <pkg> exec vitest run path/to/file.test.ts`。

## 5. 数据库迁移

结构变更必须在 `db/migrations/sqlite/` 与 `db/migrations/postgres/` 各新增一份同编号、同文件名的 `NNN_verb_snake_case.sql`（规则见 [MIGRATION_CONVENTION.md](MIGRATION_CONVENTION.md)，双方言设计见 [docs/design-storage-dual-dialect-20260911.md](docs/design-storage-dual-dialect-20260911.md)）。提交前运行 `bash tools/check-migrations.sh`，并保证迁移测试通过。所有 DB 访问走持久化抽象层，不在业务模块写裸 SQL。

## 6. 提交信息

遵循 [git-commit-message.md](git-commit-message.md)：英文 `<type>(<scope>): <imperative summary>` + 简短英文 body，原子提交，一个 commit 只做一件事；**不添加 AI co-author**；未明确要求不 push。

写入 GitHub 的内容（Issue/PR 标题与描述、comment、review、merge/release/Action 名称）一律英文；本地中文文档与面向用户的中文文案不受限。

## 7. 分支与 PR

分支职责、评审与合并流程见 [PULL_REQUEST_WORKFLOW.md](PULL_REQUEST_WORKFLOW.md)：**日常改动直接在 `dev` 提交并 push（push 前先 `pull --rebase`）**；`main` 只能经 `dev → main` 的真实 PR 合入，永不直接提交；临时分支为可选项。

**PR 合并前三件套必须全绿**：`pnpm -r typecheck`、`pnpm -r build`、`pnpm -r test`（CI 建立后以 PR 上 Actions 为准，含依赖审计与密钥扫描）。

## 8. 安全

不提交 `.env`、token、用户数据；新增环境变量同步 `.env.example`。GitHub/LLM 凭证只存在于服务端，不进源码、构建产物或 Git 历史。MVP 不 clone、不执行任何外部仓库代码。
