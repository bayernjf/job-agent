import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runMigrations } from './sqlite/migrator.js';
import { openSqlite } from './sqlite/connection.js';
import { SqliteCronHeartbeatRepository } from './sqlite/cron-heartbeat-repo.js';

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../db/migrations/sqlite',
);

const T1 = '2026-10-07T04:00:00.000Z';
const T2 = '2026-10-07T04:05:00.000Z';

function fresh() {
  const { client, db } = openSqlite(':memory:');
  runMigrations(client, MIGRATIONS_DIR);
  return {
    beats: new SqliteCronHeartbeatRepository(db),
    close: () => client.close(),
  };
}

describe('SqliteCronHeartbeatRepository', () => {
  it('records success, clears error, and upserts per consumer', async () => {
    const s = fresh();
    try {
      await s.beats.recordSuccess('process-job', T1, 'idle');
      await s.beats.recordSuccess('agent-tick', T1, 'advanced=2');

      const all = await s.beats.listAll();
      expect(all).toHaveLength(2);
      expect(all[0]).toMatchObject({ consumer: 'agent-tick', lastSuccessAt: T1, lastResult: 'advanced=2', lastError: null });
      expect(all[1]).toMatchObject({ consumer: 'process-job', lastSuccessAt: T1, lastResult: 'idle', lastError: null });

      // 同一 consumer 再次成功：只保留一行、时间前移
      await s.beats.recordSuccess('process-job', T2, 'processed=job-1');
      const again = await s.beats.listAll();
      expect(again).toHaveLength(2);
      const pj = again.find((b) => b.consumer === 'process-job')!;
      expect(pj.lastSuccessAt).toBe(T2);
      expect(pj.lastResult).toBe('processed=job-1');
      expect(pj.lastError).toBeNull();
    } finally {
      s.close();
    }
  });

  it('keeps the last success while recording a failure', async () => {
    const s = fresh();
    try {
      await s.beats.recordSuccess('process-job', T1, 'idle');
      await s.beats.recordFailure('process-job', T2, 'ECONNREFUSED');

      const row = (await s.beats.listAll())[0]!;
      expect(row.lastSuccessAt).toBe(T1); // 成功信息保留
      expect(row.lastResult).toBe('idle');
      expect(row.lastError).toBe('ECONNREFUSED');
      expect(row.updatedAt).toBe(T2);

      // 下一次成功清除错误
      await s.beats.recordSuccess('process-job', T2, 'idle');
      const cleared = (await s.beats.listAll())[0]!;
      expect(cleared.lastError).toBeNull();
      expect(cleared.lastSuccessAt).toBe(T2);
    } finally {
      s.close();
    }
  });

  it('failure before any success leaves last_success_at null', async () => {
    const s = fresh();
    try {
      await s.beats.recordFailure('agent-tick', T1, '401');
      const row = (await s.beats.listAll())[0]!;
      expect(row.consumer).toBe('agent-tick');
      expect(row.lastSuccessAt).toBeNull();
      expect(row.lastError).toBe('401');
    } finally {
      s.close();
    }
  });
});
