/**
 * `storage-bootstrap` 测试：钉住两条不变量——目标库优先级（显式 dbPath > DB_PATH >
 * 缺省 data/job-agent.db）与「注入 deps.storage 时完全绕过建库」。
 * 缺省值必须是相对路径：createStorage 按 cwd 解析，改成绝对路径会让在 apps/cli 下跑的命令换库。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createStorage } from '@jobagent/storage';
import { createCliStorage, resolveCliSqlitePath, resolveCliStorage } from './storage-bootstrap.js';

const SAVED_ENV = process.env.DB_PATH;

afterEach(() => {
  if (SAVED_ENV === undefined) delete process.env.DB_PATH;
  else process.env.DB_PATH = SAVED_ENV;
});

describe('resolveCliSqlitePath', () => {
  it('缺省＝相对路径 data/job-agent.db', () => {
    delete process.env.DB_PATH;
    expect(resolveCliSqlitePath()).toBe('data/job-agent.db');
  });

  it('DB_PATH 覆盖缺省值', () => {
    process.env.DB_PATH = ':memory:';
    expect(resolveCliSqlitePath()).toBe(':memory:');
  });

  it('显式 dbPath 覆盖 DB_PATH', () => {
    process.env.DB_PATH = ':memory:';
    expect(resolveCliSqlitePath({ dbPath: 'tmp/from-flag.db' })).toBe('tmp/from-flag.db');
  });
});

describe('resolveCliStorage', () => {
  it('注入的 storage 原样返回（不因 DB_PATH 另开一个库）', async () => {
    const injected = await createStorage({ sqlitePath: ':memory:' });
    process.env.DB_PATH = ':memory:';
    await expect(resolveCliStorage({ storage: injected })).resolves.toBe(injected);
    await injected.close();
  });

  it('未注入时按解析出的路径开库（非只读，自动迁移）', async () => {
    const storage = await createCliStorage({ dbPath: ':memory:' });
    expect(storage.driver).toBe('sqlite');
    expect(await storage.profiles.getById('prof-absent')).toBeUndefined();
    await storage.close();
  });
});
