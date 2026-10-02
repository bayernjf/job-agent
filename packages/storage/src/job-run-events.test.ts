import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runMigrations } from './sqlite/migrator.js';
import { openSqlite } from './sqlite/connection.js';
import { SqliteJobRunEventsRepository } from './sqlite/job-run-events-repo.js';
import {
  JOB_RUN_ACTORS,
  JOB_RUN_EVENT_KINDS,
  toStoredJobRunEvent,
  type NewJobRunEvent,
  type RawJobRunEventRow,
} from './entities/index.js';

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../db/migrations/sqlite',
);

function freshRepo(): { repo: SqliteJobRunEventsRepository; close: () => void } {
  const { client, db } = openSqlite(':memory:');
  runMigrations(client, MIGRATIONS_DIR);
  return { repo: new SqliteJobRunEventsRepository(db), close: () => client.close() };
}

function evt(
  overrides: Partial<NewJobRunEvent> & Pick<NewJobRunEvent, 'id' | 'runId' | 'createdAt'>,
): NewJobRunEvent {
  return {
    event: 'validate',
    fromStatus: null,
    toStatus: 'configured',
    actor: 'system',
    ...overrides,
  };
}

describe('SqliteJobRunEventsRepository', () => {
  it('appends events and reads the stream oldest-first with payload round-trip', async () => {
    const { repo, close } = freshRepo();
    await repo.insert(
      evt({
        id: 'evt-2',
        runId: 'run-1',
        event: 'start',
        fromStatus: 'configured',
        toStatus: 'watching',
        actor: 'agent',
        payload: { candidates: 12, dryRun: false, note: null },
        createdAt: '2026-10-03T02:00:00.000Z',
      }),
    );
    await repo.insert(
      evt({
        id: 'evt-1',
        runId: 'run-1',
        event: 'validate',
        fromStatus: null,
        toStatus: 'configured',
        actor: 'user',
        payload: { preferenceId: 'pref-1' },
        createdAt: '2026-10-03T01:00:00.000Z',
      }),
    );
    await repo.insert(
      evt({
        id: 'evt-other',
        runId: 'run-2',
        toStatus: 'failed',
        event: 'fail',
        createdAt: '2026-10-03T00:00:00.000Z',
      }),
    );

    const stream = await repo.listByRun('run-1');
    expect(stream.map((e) => e.id)).toEqual(['evt-1', 'evt-2']);
    expect(stream[0]!.fromStatus).toBeNull();
    expect(stream[0]!.toStatus).toBe('configured');
    expect(stream[0]!.actor).toBe('user');
    expect(stream[0]!.payload).toEqual({ preferenceId: 'pref-1' });
    expect(stream[1]!.fromStatus).toBe('configured');
    expect(stream[1]!.payload).toEqual({ candidates: 12, dryRun: false, note: null });

    expect((await repo.listByRun('run-1', 1)).map((e) => e.id)).toEqual(['evt-1']);
    close();
  });

  it('defaults an omitted payload to an empty object', async () => {
    const { repo, close } = freshRepo();
    await repo.insert(evt({ id: 'evt-1', runId: 'run-1', createdAt: '2026-10-03T01:00:00.000Z' }));
    const [stored] = await repo.listByRun('run-1');
    expect(stored!.payload).toEqual({});
    close();
  });

  it('exposes the shared event-kind and actor domains', () => {
    // 事件全集归 @jobagent/shared（设计 §5.2）。不断言精确条数：契约侧新增迁移事件
    // （例如 submitted → tracking 的 'track'）不应让本层红一次假警报；
    // 但要保证设计 §5.2 的每条迁移都在，且没有重复值。
    for (const kind of [
      'validate',
      'start',
      'candidates_ready',
      'generated',
      'approve',
      'reject',
      'rescan',
      'submitted',
      'archive',
      'fail',
      'cancel',
    ]) {
      expect(JOB_RUN_EVENT_KINDS).toContain(kind);
    }
    expect(JOB_RUN_EVENT_KINDS.length).toBeGreaterThanOrEqual(11);
    expect(new Set(JOB_RUN_EVENT_KINDS).size).toBe(JOB_RUN_EVENT_KINDS.length);
    expect(JOB_RUN_ACTORS).toEqual(['user', 'agent', 'system']);
  });

  it('falls back safely for unknown event/actor/status and filters bad payload values', () => {
    const row: RawJobRunEventRow = {
      id: 'evt-x',
      runId: 'run-1',
      event: 'explode',
      fromStatus: 'nope',
      toStatus: 'also_nope',
      actor: 'robot',
      payload: '{"ok":1,"nested":{"a":1}}',
      createdAt: '2026-10-03T01:00:00.000Z',
    };
    const stored = toStoredJobRunEvent(row);
    // 未知事件落成显式失败，未知动作方不记到用户头上，未知状态不伪装成成功
    expect(stored.event).toBe('fail');
    expect(stored.actor).toBe('system');
    expect(stored.fromStatus).toBeNull();
    expect(stored.toStatus).toBe('failed');
    // 嵌套值被丢弃，标量保留
    expect(stored.payload).toEqual({ ok: 1 });

    const broken = toStoredJobRunEvent({ ...row, payload: 'not json' });
    expect(broken.payload).toEqual({});
  });
});
