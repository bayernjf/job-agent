# db/migrations

数据库编号 SQL 迁移目录，按方言对称组织。命名、文件头、幂等与回滚规则统一见仓库根目录的 **[../../MIGRATION_CONVENTION.md](../../MIGRATION_CONVENTION.md)**，双方言设计见 **[../../docs/design-storage-dual-dialect-20260911.md](../../docs/design-storage-dual-dialect-20260911.md)**。

- `sqlite/`：SQLite 方言（本地开发 / #8 离线实验 / 单机工具），列含义用内联 `--` 注释。
- `postgres/`：Postgres 方言（生产），列含义用 `COMMENT ON`。
- **两侧编号与文件名必须一一对应**：同一次结构变更在两个目录各落一份同编号、同文件名的迁移。
- 文件命名：`NNN_verb_snake_case.sql`，从 `001` 起严格连续，只追加不重写。
- 校验：`bash tools/check-migrations.sh`（只读，校验两目录命名/编号/文件头及跨目录对齐）。
- 应用 / 回滚：`pnpm migrate:up` / `pnpm migrate:down` / `pnpm migrate:status`（经 `packages/storage` CLI；默认 SQLite `data/job-agent.db`，Postgres 经 `DB_DRIVER=postgres` + `DATABASE_URL`）。

> 本目录是 schema 演进的单一事实源：Drizzle 表定义（`packages/storage/src/{sqlite,postgres}/schema.ts`）必须与对应方言的编号迁移保持一致（MIGRATION_CONVENTION 第 6 节）。
