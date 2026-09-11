import type { Sql } from 'postgres';
import {
  listMigrationFiles,
  parseMigrationFile,
  splitStatements,
  type RollbackResult,
  type RunMigrationsResult,
} from '../migrations-fs.js';

/**
 * Postgres 异步迁移器。文件枚举/段解析复用 migrations-fs，
 * 只负责在 postgres-js 连接上按序执行（DDL 按分号拆成简单语句逐条 await）。
 */

export async function createPgSchemaMigrationsTable(sql: Sql): Promise<void> {
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

/** 在给定连接上按序应用未应用的迁移，返回本次新应用的文件名列表 */
export async function runPgMigrations(
  sql: Sql,
  migrationsDir: string,
): Promise<RunMigrationsResult> {
  await createPgSchemaMigrationsTable(sql);
  const appliedRows = await sql<Array<{ version: string }>>`SELECT version FROM schema_migrations`;
  const appliedVersions = new Set(appliedRows.map((r) => r.version));

  const files = listMigrationFiles(migrationsDir);
  const applied: string[] = [];

  for (const file of files) {
    const version = file.slice(0, 3);
    if (appliedVersions.has(version)) continue;
    const raw = await readFile(migrationsDir, file);
    const { up } = parseMigrationFile(raw);
    for (const statement of splitStatements(up)) {
      await sql.unsafe(statement);
    }
    await sql`INSERT INTO schema_migrations (version) VALUES (${version})`;
    applied.push(file);
  }

  return { applied, total: files.length };
}

async function readFile(migrationsDir: string, file: string): Promise<string> {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  return fs.readFile(path.join(migrationsDir, file), 'utf8');
}

/** 回滚最新一个迁移；无 down 段时拒绝（MIGRATION_CONVENTION 第 5 节） */
export async function rollbackPgMigration(
  sql: Sql,
  migrationsDir: string,
): Promise<RollbackResult> {
  await createPgSchemaMigrationsTable(sql);
  const rows =
    await sql<Array<{ version: string }>>`SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1`;
  const row = rows[0];
  if (!row) throw new Error('No applied migration to roll back.');

  const { version } = row;
  const files = listMigrationFiles(migrationsDir).filter((f) => f.startsWith(`${version}_`));
  if (files.length !== 1) {
    throw new Error(`Cannot resolve migration file for version ${version}.`);
  }

  const raw = await readFile(migrationsDir, files[0]!);
  const { down } = parseMigrationFile(raw);
  if (!down) {
    throw new Error(
      `Migration ${version} has no safe down script; refusing to roll back (MIGRATION_CONVENTION 第 5 节).`,
    );
  }

  for (const statement of splitStatements(down)) {
    await sql.unsafe(statement);
  }
  await sql`DELETE FROM schema_migrations WHERE version = ${version}`;
  return { version, file: files[0]! };
}
