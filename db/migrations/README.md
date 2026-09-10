# db/migrations

数据库编号 SQL 迁移目录。命名、文件头、幂等与回滚规则统一见仓库根目录的 **[../../MIGRATION_CONVENTION.md](../../MIGRATION_CONVENTION.md)**。

- 文件命名：`NNN_verb_snake_case.sql`，从 `001` 起严格连续。
- 校验：`bash tools/check-migrations.sh`（只读）。
- 当前为文档/约定阶段，尚无代码与首个迁移；首个迁移（如 `001_create_profiles.sql`）在脚手架期 W1 随持久化层一起落地。

> 本文件仅用于在尚无迁移时锚定目录并说明约定，首个迁移加入后可保留作为目录说明。
