# db/migrations

数据库编号 SQL 迁移目录。命名、文件头、幂等与回滚规则统一见仓库根目录的 **[../../MIGRATION_CONVENTION.md](../../MIGRATION_CONVENTION.md)**。

- 文件命名：`NNN_verb_snake_case.sql`，从 `001` 起严格连续。
- 校验：`bash tools/check-migrations.sh`（只读）。
- 应用 / 回滚：`pnpm migrate:up` / `pnpm migrate:down` / `pnpm migrate:status`（经 `packages/storage` CLI，默认数据库 `data/job-agent.db`）。
- 首个迁移：`001_create_profiles.sql`（profiles 画像快照表，SQLite 方言，含 down 段）。

> 本目录同时是 schema 演进的单一事实源：Drizzle 表定义（`packages/storage/src/schema.ts`）必须与编号迁移保持一致（见 MIGRATION_CONVENTION 第 6 节）。
