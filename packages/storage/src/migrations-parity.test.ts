import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { listMigrationFiles, parseMigrationFile } from './migrations-fs.js';

/**
 * 双方言迁移文本一致性（无数据库实例）：
 * sqlite/ 与 postgres/ 两目录的文件名/编号集合必须一一对应，
 * 每张表的列名集合与索引名集合一致（类型族可不同：INTEGER↔BOOLEAN），且都带安全 DOWN 段。
 */

const MIGRATIONS_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../db/migrations',
);
const SQLITE_DIR = path.join(MIGRATIONS_ROOT, 'sqlite');
const POSTGRES_DIR = path.join(MIGRATIONS_ROOT, 'postgres');

function read(file: string): string {
  return fs.readFileSync(file, 'utf8');
}

/** 提取 CREATE TABLE (...) 块内定义的列名（两空格缩进起手的标识符行） */
function columnNames(sql: string, table: string): string[] {
  const block = new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\s*\\(([\\s\\S]*?)\\);`).exec(sql);
  if (!block) throw new Error(`cannot locate CREATE TABLE ${table}`);
  return Array.from(block[1]!.matchAll(/^\s{2}([a-z_][a-z0-9_]*)\s+/gm)).map((m) => m[1]!);
}

/** 提取 CREATE INDEX 名 */
function indexNames(sql: string): string[] {
  return Array.from(sql.matchAll(/CREATE INDEX IF NOT EXISTS\s+([a-z_][a-z0-9_]*)/gi)).map(
    (m) => m[1]!,
  );
}

const TABLES = ['profiles', 'analysis_jobs', 'evidence', 'waitlist'];

describe('sqlite/postgres migration parity', () => {
  it('has identical, strictly consecutive file sets in both dialect directories', () => {
    const sqliteFiles = listMigrationFiles(SQLITE_DIR);
    const pgFiles = listMigrationFiles(POSTGRES_DIR);

    expect(sqliteFiles).toEqual(pgFiles);
    expect(sqliteFiles.length).toBeGreaterThan(0);
    sqliteFiles.forEach((file, i) => {
      expect(Number(file.slice(0, 3))).toBe(i + 1);
    });
  });

  it.each(TABLES)('table %s has the same columns and indexes in both dialects', (table) => {
    const file = listMigrationFiles(SQLITE_DIR).find((f) => f.includes(table))!;
    const sqliteSql = read(path.join(SQLITE_DIR, file));
    const pgSql = read(path.join(POSTGRES_DIR, file));

    expect(columnNames(pgSql, table).sort()).toEqual(columnNames(sqliteSql, table).sort());
    expect(indexNames(pgSql).sort()).toEqual(indexNames(sqliteSql).sort());
  });

  it('every migration in both dialects carries a non-empty DOWN section', () => {
    for (const dir of [SQLITE_DIR, POSTGRES_DIR]) {
      for (const file of listMigrationFiles(dir)) {
        const { down } = parseMigrationFile(read(path.join(dir, file)));
        expect(down, `${file} missing DOWN`).toBeTruthy();
      }
    }
  });

  it('postgres migrations use COMMENT ON for column documentation', () => {
    for (const file of listMigrationFiles(POSTGRES_DIR)) {
      const sql = read(path.join(POSTGRES_DIR, file));
      expect(sql, `${file} should document columns via COMMENT ON`).toContain('COMMENT ON');
    }
  });
});
