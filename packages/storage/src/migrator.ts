import fs from 'node:fs';
import path from 'node:path';
import type { Database } from 'better-sqlite3';

/**
 * 迁移器（MIGRATION_CONVENTION 第 5 节）。
 *
 * - 按 NNN 顺序应用 `db/migrations/*.sql`，在 `schema_migrations` 记录已应用版本。
 * - 迁移文件可在末尾携带 `-- DOWN BEGIN ... -- DOWN END` 段；up 只执行段外部分，
 *   down 段仅由 rollbackLatestMigration 使用（无 down 段的迁移不可回滚）。
 * - 本模块位于持久化层内部，直接执行 DDL 属于该层实现细节，不违反「业务模块禁裸 SQL」。
 */

export interface ParsedMigration {
  up: string;
  down: string | null;
}

/** 解析迁移文件：提取 up 段与可选 down 段 */
export function parseMigrationFile(sql: string): ParsedMigration {
  const downMatch = sql.match(/--\s*DOWN\s*BEGIN([\s\S]*?)--\s*DOWN\s*END/);
  if (!downMatch) return { up: sql, down: null };
  return {
    up: sql.slice(0, downMatch.index ?? sql.length),
    down: downMatch[1]!.trim(),
  };
}

export function createSchemaMigrationsTable(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
    )
  `);
}

/** 列出迁移目录内合法的 NNN_verb_snake_case.sql，按编号排序 */
export function listMigrationFiles(migrationsDir: string): string[] {
  return fs
    .readdirSync(migrationsDir)
    .filter((f) => /^\d{3}_[a-z][a-z0-9_]*\.sql$/.test(f))
    .sort();
}

export interface RunMigrationsResult {
  applied: string[];
  total: number;
}

/** 在给定连接上按序应用未应用的迁移，返回本次新应用的版本号列表 */
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

export interface RollbackResult {
  version: string;
  file: string;
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
