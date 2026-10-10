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

    // 契约（2026-10-10 改）：limit 取的是**最新** N 条，返回顺序仍是时间正序。
    // 旧语义（asc + limit）取的是最旧 N 条，会让事件流在跑满上限后冻住。
    expect((await repo.listByRun('run-1', 1)).map((e) => e.id)).toEqual(['evt-2']);
    close();
  });

  it('keeps the newest events when the stream exceeds the limit', async () => {
    const { repo, close } = freshRepo();
    const base = Date.parse('2026-10-10T00:00:00.000Z');
    for (let i = 0; i < 250; i += 1) {
      await repo.insert(
        evt({
          id: `evt-${String(i).padStart(3, '0')}`,
          runId: 'run-big',
          event: 'rescan',
          fromStatus: 'watching',
          toStatus: 'watching',
          actor: 'agent',
          createdAt: new Date(base + i * 60_000).toISOString(),
        }),
      );
    }

    const page = await repo.listByRun('run-big', 200);
    expect(page).toHaveLength(200);
    // 最旧 50 条被截断，最新一条必须在；顺序仍是正序（回放顺序）
    expect(page[0]!.id).toBe('evt-050');
    expect(page[page.length - 1]!.id).toBe('evt-249');
    const times = page.map((e) => Date.parse(e.createdAt));
    expect(times).toEqual([...times].sort((a, b) => a - b));
    close();
  });

  // 同一次 tick 会落多条迁移，它们的 created_at 逐字节相同；主键是 evt-<uuid>，
  // 字典序与时间无关，所以回放顺序必须由写入顺序（rowid / ctid）兜住。
  it('keeps write order for events sharing a timestamp, at the window edge too', async () => {
    const { repo, close } = freshRepo();
    const same = '2026-10-10T06:00:00.000Z';
    // 刻意让 id 的字典序与写入顺序相反，这样"按 id 排"必定红
    const order = ['evt-zzz', 'evt-mmm', 'evt-aaa'];
    for (const [i, id] of order.entries()) {
      await repo.insert(
        evt({
          id,
          runId: 'run-tie',
          event: i === 0 ? 'start' : i === 1 ? 'candidates_ready' : 'generated',
          fromStatus: i === 0 ? 'created' : 'watching',
          toStatus: i === 2 ? 'awaiting_approval' : 'watching',
          createdAt: same,
        }),
      );
    }

    expect((await repo.listByRun('run-tie')).map((e) => e.id)).toEqual(order);
    // 窗口正好截在同一时刻中间时，留下的是该时刻**后写入**的那两条（取最新），
    // 但它们的相对顺序仍按写入顺序返回，不会倒过来
    expect((await repo.listByRun('run-tie', 2)).map((e) => e.id)).toEqual(['evt-mmm', 'evt-aaa']);
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
