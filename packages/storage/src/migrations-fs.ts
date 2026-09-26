import fs from 'node:fs';

/**
 * 迁移文件层（方言无关）：文件枚举与 up/down 段解析。
 * SQLite（同步）与 Postgres（异步）两套迁移器共用，避免解析规则漂移。
 */

export interface ParsedMigration {
  up: string;
  down: string | null;
}

/** 解析迁移文件：提取 up 段与可选 down 段（-- DOWN BEGIN ... -- DOWN END） */
export function parseMigrationFile(sql: string): ParsedMigration {
  const downMatch = sql.match(/--\s*DOWN\s*BEGIN([\s\S]*?)--\s*DOWN\s*END/);
  if (!downMatch) return { up: sql, down: null };
  return {
    up: sql.slice(0, downMatch.index ?? sql.length),
    down: downMatch[1]!.trim(),
  };
}

/** 列出迁移目录内合法的 NNN_verb_snake_case.sql，按编号排序 */
export function listMigrationFiles(migrationsDir: string): string[] {
  return fs
    .readdirSync(migrationsDir)
    .filter((f) => /^\d{3}_[a-z][a-z0-9_]*\.sql$/.test(f))
    .sort();
}

export interface RunMigrationsResult {
  /** 本次新应用的迁移文件名 */
  applied: string[];
  /** 目录内迁移文件总数 */
  total: number;
}

export interface RollbackResult {
  version: string;
  file: string;
}

/** 读取一个迁移文件并解析 */
export function readMigrationFile(migrationsDir: string, fileName: string): ParsedMigration {
  return parseMigrationFile(fs.readFileSync(`${migrationsDir}/${fileName}`, 'utf8'));
}
