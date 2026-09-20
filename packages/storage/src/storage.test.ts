/**
 * 存储工厂环境开关测试（形态 C：serverless 下用 DB_AUTO_MIGRATE=false 禁止冷启动迁移）。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { envAutoMigrate } from './storage.js';

describe('envAutoMigrate (DB_AUTO_MIGRATE)', () => {
  const original = process.env.DB_AUTO_MIGRATE;

  afterEach(() => {
    if (original === undefined) delete process.env.DB_AUTO_MIGRATE;
    else process.env.DB_AUTO_MIGRATE = original;
  });

  it('returns undefined when unset or blank (caller falls back to the readonly rule)', () => {
    delete process.env.DB_AUTO_MIGRATE;
    expect(envAutoMigrate()).toBeUndefined();
    process.env.DB_AUTO_MIGRATE = '   ';
    expect(envAutoMigrate()).toBeUndefined();
  });

  it('parses only true/false case-insensitively and rejects other values', () => {
    process.env.DB_AUTO_MIGRATE = 'false';
    expect(envAutoMigrate()).toBe(false);
    process.env.DB_AUTO_MIGRATE = ' TRUE ';
    expect(envAutoMigrate()).toBe(true);
    process.env.DB_AUTO_MIGRATE = '1';
    expect(envAutoMigrate()).toBeUndefined();
    process.env.DB_AUTO_MIGRATE = 'yes';
    expect(envAutoMigrate()).toBeUndefined();
  });
});
