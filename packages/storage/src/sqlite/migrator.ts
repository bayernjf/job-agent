import fs from 'node:fs';
import path from 'node:path';
import type { Database } from 'better-sqlite3';
import {
  listMigrationFiles,
  parseMigrationFile,
  type RollbackResult,
  type RunMigrationsResult,
} from '../migrations-fs.js';

/**
 * SQLite 迁移器（MIGRATION_CONVENTION 第 5 节），同步执行（better-sqlite3 驱动同步）。
 *
 * - 按 NNN 顺序应用 `db/migrations/sqlite/*.sql`，在 `schema_migrations` 记录已应用版本。
 * - 迁移文件可在末尾携带 `-- DOWN BEGIN ... -- DOWN END` 段；up 只执行段外部分，
 *   down 段仅由 rollbackLatestMigration 使用（无 down 段的迁移不可回滚）。
 * - 文件枚举/段解析/结果类型复用方言无关的 migrations-fs；本模块只负责在 SQLite 连接上执行。
 */

export { parseMigrationFile, listMigrationFiles } from '../migrations-fs.js';
export type {
  ParsedMigration,
  RunMigrationsResult,
  RollbackResult,
} from '../migrations-fs.js';

export function createSchemaMigrationsTable(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
    )
  `);
}

/** 在给定连接上按序应用未应用的迁移，返回本次新应用的文件名列表 */
export function runMigrations(db: Database, migrationsDir: string): RunMigrationsResult {
  createSchemaMigrationsTable(db);
  const appliedVersions = new Set(
    (db.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: string }>).map(
      (r) => r.version,
    ),
  );

  const files = listMigrationFiles(migrationsDir);
  const applied: string[] = [];

  for (const file of files) {
    const version = file.slice(0, 3);
    if (appliedVersions.has(version)) continue;
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    const { up } = parseMigrationFile(sql);
    db.exec(up);
    db.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(version);
    applied.push(file);
  }

  return { applied, total: files.length };
}

/** 回滚最新一个迁移；无 down 段时拒绝（MIGRATION_CONVENTION 第 5 节） */
export function rollbackLatestMigration(db: Database, migrationsDir: string): RollbackResult {
  createSchemaMigrationsTable(db);
  const row = db
    .prepare('SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1')
    .get() as { version: string } | undefined;
  if (!row) throw new Error('No applied migration to roll back.');

  const { version } = row;
  const files = listMigrationFiles(migrationsDir).filter((f) => f.startsWith(`${version}_`));
  if (files.length !== 1) {
    throw new Error(`Cannot resolve migration file for version ${version}.`);
  }

  const sql = fs.readFileSync(path.join(migrationsDir, files[0]!), 'utf8');
  const { down } = parseMigrationFile(sql);
  if (!down) {
    throw new Error(
      `Migration ${version} has no safe down script; refusing to roll back (MIGRATION_CONVENTION 第 5 节).`,
    );
  }

  db.exec(down);
  db.prepare('DELETE FROM schema_migrations WHERE version = ?').run(version);
  return { version, file: files[0]! };
}
