import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runMigrations } from './sqlite/migrator.js';
import { openSqlite } from './sqlite/connection.js';
import { sqliteVerifyRequiredColumns } from './sqlite/verify-required-columns.js';

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../db/migrations/sqlite',
);

/**
 * 迁移漂移守卫（deferred「迁移漂移守卫」）：
 * verifyRequiredColumns 直接查实际 schema，不读 schema_migrations 账本。
 * 账本只记迁移器自写的文件名（前 3 位版本号），手工重放的迁移没有记录——
 * 读账本会误报；023 的 ADD COLUMN is_admin 无 IF NOT EXISTS，不能按账本重放。
 */
const REQUIRED = [
  { table: 'accounts', column: 'recruiter_declared_at' },
  { table: 'profiles', column: 'removal_requested_at' },
  { table: 'job_runs', column: 'last_scan_at' },
  { table: 'job_runs', column: 'last_viewed_at' },
  { table: 'submit_intents', column: 'application_id' },
  { table: 'accounts', column: 'is_admin' },
  { table: 'llm_catalog_models', column: 'id' },
  { table: 'user_llm_configs', column: 'account_id' },
  { table: 'api_tokens', column: 'id' },
  { table: 'claim_verifications', column: 'id' },
  { table: 'cron_heartbeat', column: 'consumer' },
];

function fresh() {
  const { client } = openSqlite(':memory:');
  runMigrations(client, MIGRATIONS_DIR);
  return client;
}

describe('sqliteVerifyRequiredColumns', () => {
  it('returns an empty list when every required column exists', () => {
    const client = fresh();
    try {
      const missing = sqliteVerifyRequiredColumns(client, REQUIRED);
      expect(missing).toEqual([]);
    } finally {
      client.close();
    }
  });

  it('reports columns of a dropped table as missing', () => {
    const client = fresh();
    try {
      // 模拟漂移：整表缺失（手工回滚 029 但代码仍引用）
      client.prepare('DROP TABLE claim_verifications').run();
      const missing = sqliteVerifyRequiredColumns(client, REQUIRED);
      expect(missing).toContain('claim_verifications.id');
      expect(missing).not.toContain('accounts.is_admin');
    } finally {
      client.close();
    }
  });

  it('reports a single missing column, leaving the rest intact', () => {
    const client = fresh();
    try {
      // 模拟"部分回滚 030"：job_runs.last_viewed_at 被回滚掉
      client.prepare('ALTER TABLE job_runs DROP COLUMN last_viewed_at').run();
      const missing = sqliteVerifyRequiredColumns(client, REQUIRED);
      expect(missing).toEqual(['job_runs.last_viewed_at']);
    } finally {
      client.close();
    }
  });
});
