# Migration Convention

> 本仓库所有数据库结构变更都通过**编号 SQL 迁移文件**管理，是 schema 演进的单一事实源。
> 规则与 `agent-world` / `tab-manager` 对齐；本项目不是 Supabase 工程，迁移统一放在 **`db/migrations/`**。

## 1. 目录归属

| 场景 | 迁移目录 |
| --- | --- |
| Supabase 项目 | `supabase/migrations/`（本项目不适用） |
| **SQLite（本地/实验）** | **`db/migrations/sqlite/`** |
| **Postgres（生产）** | **`db/migrations/postgres/`**（两目录编号/文件名一一对应，check 脚本断言对齐，见 [docs/design-storage-dual-dialect-20260911.md](docs/design-storage-dual-dialect-20260911.md)） |

## 2. 文件命名：`NNN_verb_snake_case.sql`

- `NNN`：三位数字，**从 `001` 开始严格 +1 连续**，不重复、不跳号；已合入 `main`/`dev` 的编号永不复用。
- `verb_snake_case`：英文小写、下划线分隔，**动词开头**（`create_` / `add_` / `alter_` / `fix_` / `drop_` / `set_` / `rename_` 等）。
- **一个文件只做一件事**（建一张表、加一列、修一类数据）；不要把结构变更和大批量数据改写混在同一文件。

## 3. 必备文件头注释

每个迁移文件开头必须包含（前 12 行内）：

```sql
-- Migration NNN: <one-line English summary>
-- File: NNN_verb_snake_case.sql        -- 必须与实际文件名完全一致
-- Date: YYYY-MM-DD HH:mm               -- 创建时的本地时间（24 小时制、精确到分），之后不再修改
-- Depends on: NNN (optional)           -- 有前置迁移时注明
-- Ref: <design doc / issue> (optional) -- 设计依据
-- Run: <how to apply> (optional)       -- 特殊执行方式
-- Note: <caveat / rationale> (optional)
```

- 创建后若需修改**尚未合入**的迁移，追加 `-- Updated: YYYY-MM-DD HH:mm 说明`，不要改原始 `-- Date:`。
- `tools/check-migrations.sh` 会强制校验命名、连续编号、文件头以及 `-- File:` 与实际文件名一致。

## 4. SQL 编写规则

- **尽量幂等**：`CREATE TABLE IF NOT EXISTS`、`ADD COLUMN IF NOT EXISTS`、`DROP ... IF EXISTS`，可重复执行不报错。
- 标识符一律 `snake_case`；数据库字段 `snake_case`，TypeScript 字段 `camelCase`，两者转换只允许出现在数据访问层。
- **每张表、每列都要说明业务含义**（枚举值在注释里写清取值）：Postgres 方言用 `COMMENT ON`；**SQLite 方言（MVP 本地/实验）无 `COMMENT ON`，改为在列定义上方以内联注释 `-- <列名>: <含义>` 说明**。
- 迁移**只追加、不重写**：已上线/已合入的迁移不改写、不删除；需要改结构就新增一个迁移。
- 没有安全逆向操作的数据迁移，必须在 `-- Note:` 显式声明，回滚脚本会拒绝无 `down` 的回滚。

## 5. 应用 / 回滚 / 校验（W1 已落地）

- **向前应用**：迁移器按 `NNN` 顺序应用，记录已应用版本。
- **回滚一步**：`scripts/migrate-down`（经持久化层的 `rollbackLatestMigration`；最新迁移无安全 down 时拒绝执行）。迁移文件末尾可携带 down 脚本段（放在 up 内容之后）：

  ```sql
  -- DOWN BEGIN
  DROP TABLE IF EXISTS xxx;
  -- DOWN END
  ```

  迁移器只执行段外部分作为 up；有 down 段的迁移可回滚，无 down 段的迁移视为不可回滚、`migrate-down` 拒绝执行。
- **规范校验**：`bash tools/check-migrations.sh`（只读，不改动文件；作为 CI 门禁）。
- **迁移测试**：`migrations.test.ts` 守护所有迁移能在干净库上顺序加载、编号连续、关键表/列存在。

## 6. 与 Drizzle ORM 的关系（本项目约定）

- **Drizzle 只在持久化模块内部用于类型化查询**；所有 DB 访问必须经单一持久化/仓储抽象（见 `AGENTS.md`「数据访问抽象层」），调用方不写裸 SQL、不感知方言。
- **结构变更通过新增本目录下的编号 SQL 迁移完成**，不在各处散落 Drizzle 生成/手写的建表语句；持久化模块内的 Drizzle 表定义必须与这些迁移保持一致。
- 这样保留 Drizzle 的类型安全，同时让 schema 演进可审计、可回滚、可在 Postgres/SQLite 间对齐方言（方言差异只允许出现在持久化层）。
