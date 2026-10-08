import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveExistingMigrationsDir } from './storage.js';

/**
 * resolveExistingMigrationsDir：standalone 打包后默认 __dirname 相对路径失效时，
 * 必须能回退到候选位置，或给出带尝试清单的明确错误（而不是 readdir ENOENT）。
 * 注：在本仓库测试环境里 __dirname 相对候选必然命中真实 db/migrations，因此
 * "全部未命中→抛错" 与 "cwd 回退优先于 __dirname" 两条路径无法在此隔离触发，
 * 由 /tmp standalone 冒烟脚本人工取证（见 handoff 记录）。
 */
describe('resolveExistingMigrationsDir', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ja-migdir-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('returns an explicit dir that contains .sql files as-is', () => {
    const dir = path.join(tmp, 'custom', 'migrations', 'sqlite');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '001_init.sql'), 'CREATE TABLE t(id INTEGER);');
    expect(resolveExistingMigrationsDir(dir, 'sqlite')).toBe(path.normalize(dir));
  });

  it('falls back to the repository migrations when the preferred dir does not exist', () => {
    // Vitest runs from the repository; even with a bogus preferred path the
    // __dirname-relative candidate resolves to the real db/migrations/sqlite.
    const resolved = resolveExistingMigrationsDir(path.join(tmp, 'missing'), 'sqlite');
    expect(fs.existsSync(resolved)).toBe(true);
    expect(fs.readdirSync(resolved).some((f) => f.endsWith('.sql'))).toBe(true);
    expect(resolved.replaceAll(path.sep, '/')).toMatch(/db\/migrations\/sqlite$/);
  });

  it('skips an existing-but-empty preferred dir and keeps searching candidates', () => {
    const empty = path.join(tmp, 'empty');
    fs.mkdirSync(empty, { recursive: true });
    const resolved = resolveExistingMigrationsDir(empty, 'postgres');
    expect(fs.existsSync(resolved)).toBe(true);
    expect(resolved.replaceAll(path.sep, '/')).toMatch(/db\/migrations\/postgres$/);
  });

  it('honours an explicit standalone migrations path carrying db/migrations', () => {
    const appDb = path.join(tmp, 'app', 'db', 'migrations', 'sqlite');
    fs.mkdirSync(appDb, { recursive: true });
    fs.writeFileSync(path.join(appDb, '001_init.sql'), 'SELECT 1;');
    expect(resolveExistingMigrationsDir(appDb, 'sqlite')).toBe(path.normalize(appDb));
  });
});
