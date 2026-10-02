/**
 * SQLite 连接工厂确定性单测（2026-10-03）。
 *
 * 回归点：CI 全新 checkout 下 data/ 等 gitignored 目录不存在，且 report 这类
 * readonly 连接可能先于任何写入方启动——openSqlite 必须自己保证父目录存在、
 * 只读打开不存在的库文件时先建空库，否则 "unable to open database file"。
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openSqlite } from './connection.js';

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), 'ja-sqlite-conn-'));
}

describe('openSqlite', () => {
  it('creates missing parent dirs and the db file in writable mode', () => {
    const root = freshDir();
    const dbPath = join(root, 'nested', 'dirs', 'fresh.db');
    const { client, db } = openSqlite(dbPath);
    expect(existsSync(dbPath)).toBe(true);
    expect(db).toBeDefined();
    client.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('opens a readonly connection against a missing db file (creates empty file, no data write)', () => {
    const root = freshDir();
    const dbPath = join(root, 'only-read.db');
    const { client } = openSqlite(dbPath, { readonly: true });
    expect(existsSync(dbPath)).toBe(true);
    // 空库可被后续写入方打开建表
    const w = openSqlite(dbPath, { readonly: false });
    w.client.exec('CREATE TABLE t (id TEXT PRIMARY KEY);');
    w.client.close();
    client.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('opens readonly against an existing db file without touching it', () => {
    const root = freshDir();
    const dbPath = join(root, 'existing.db');
    const w = openSqlite(dbPath);
    w.client.exec('CREATE TABLE t (id TEXT PRIMARY KEY); INSERT INTO t VALUES (\'a\');');
    w.client.close();
    const { client } = openSqlite(dbPath, { readonly: true });
    const row = client.prepare('SELECT COUNT(*) AS n FROM t').get() as { n: number };
    expect(row.n).toBe(1);
    client.close();
    rmSync(root, { recursive: true, force: true });
  });
});
