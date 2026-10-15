import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { RecordFunnelInputSchema, type RecordFunnelInput } from '@jobagent/shared';
import type { FunnelEventRecord } from './entities/funnel-event.js';
import type { IFunnelEventsRepository } from './repositories/funnel-events.js';
import { runMigrations } from './sqlite/migrator.js';
import { openSqlite } from './sqlite/connection.js';
import { SqliteFunnelEventsRepository } from './sqlite/funnel-events-repo.js';
import {
  FUNNEL_VIEW_DEDUPE_WINDOW_MS,
  createFunnelRecorder,
  createNullFunnelRecorder,
} from './funnel-recorder.js';

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../db/migrations/sqlite',
);

function fresh() {
  const { client, db } = openSqlite(':memory:');
  runMigrations(client, MIGRATIONS_DIR);
  return {
    repo: new SqliteFunnelEventsRepository(db),
    close: () => client.close(),
  };
}

/** 造一条完整事件行：除给出的字段外全部归 null（与 recorder 的归一行为一致）。 */
function ev(
  partial: Pick<FunnelEventRecord, 'id' | 'event' | 'createdAt'> & Partial<FunnelEventRecord>,
): FunnelEventRecord {
  return {
    sessionRef: null,
    profileId: null,
    requester: null,
    ...partial,
  };
}

const P1 = '11111111-1111-4111-8111-111111111111';
const P2 = '22222222-2222-4222-8222-222222222222';

// 固定夹具：跨两个自然日、四类事件、含 NULL 会话（NULL 组）与 until 边界外对照行。
const E1 = ev({
  id: 'fe-e1',
  event: 'analyze_enqueued',
  sessionRef: 'sid-a',
  requester: 'user',
  createdAt: '2026-10-14T23:30:00.000Z',
});
const E2 = ev({
  id: 'fe-e2',
  event: 'analyze_enqueued',
  sessionRef: 'sid-a',
  requester: 'demo',
  createdAt: '2026-10-15T00:30:00.000Z',
});
const E3 = ev({
  id: 'fe-e3',
  event: 'report_viewed',
  sessionRef: 'sid-b',
  profileId: P1,
  requester: 'visitor',
  createdAt: '2026-10-15T01:00:00.000Z',
});
const E4 = ev({
  id: 'fe-e4',
  event: 'share_clicked',
  profileId: P1,
  createdAt: '2026-10-15T02:00:00.000Z',
});
// 窗口外对照：恰好落在 until 边界上（until 不含）。
const E5 = ev({
  id: 'fe-e5',
  event: 'analyze_cache_hit',
  createdAt: '2026-10-16T00:00:00.000Z',
});

async function seed(repo: IFunnelEventsRepository): Promise<void> {
  for (const e of [E1, E2, E3, E4, E5]) await repo.insert(e);
}

const SINCE = '2026-10-14T00:00:00.000Z';
const UNTIL = '2026-10-16T00:00:00.000Z';

describe('SqliteFunnelEventsRepository', () => {
  it('aggregates by event with distinct-session and NULL-group counts in deterministic order', async () => {
    const s = fresh();
    try {
      await seed(s.repo);
      const rows = await s.repo.summarize({ sinceIso: SINCE, untilIso: UNTIL });
      // E5 恰好等于 until（不含）被排除；E1+E2 同 sid-a 只算一个去重会话。
      expect(rows).toEqual([
        { event: 'analyze_enqueued', events: 2, distinctSessions: 1, nullSessions: 0 },
        { event: 'report_viewed', events: 1, distinctSessions: 1, nullSessions: 0 },
        // share_clicked 无 cookie：不进 distinct、单独落 NULL 组。
        { event: 'share_clicked', events: 1, distinctSessions: 0, nullSessions: 1 },
      ]);
    } finally {
      s.close();
    }
  });

  it('treats since as inclusive and until as exclusive; omitted until reads to the latest', async () => {
    const s = fresh();
    try {
      await seed(s.repo);
      // since 恰好等于 E1 之后的时刻：E1 被切掉，analyze_enqueued 只剩 E2。
      const tail = await s.repo.summarize({ sinceIso: '2026-10-15T00:00:00.000Z', untilIso: UNTIL });
      expect(tail.map((r) => [r.event, r.events])).toEqual([
        ['analyze_enqueued', 1],
        ['report_viewed', 1],
        ['share_clicked', 1],
      ]);
      // 省略 until：E5（analyze_cache_hit）进来。
      const open = await s.repo.summarize({ sinceIso: SINCE });
      expect(open.map((r) => r.event)).toEqual([
        'analyze_cache_hit',
        'analyze_enqueued',
        'report_viewed',
        'share_clicked',
      ]);
      expect(open[0]).toMatchObject({ events: 1, distinctSessions: 0, nullSessions: 1 });
    } finally {
      s.close();
    }
  });

  it('buckets daily rows by UTC calendar day and event', async () => {
    const s = fresh();
    try {
      await seed(s.repo);
      const days = await s.repo.summarizeDaily({ sinceIso: SINCE, untilIso: UNTIL });
      expect(days).toEqual([
        { day: '2026-10-14', event: 'analyze_enqueued', events: 1 },
        { day: '2026-10-15', event: 'analyze_enqueued', events: 1 },
        { day: '2026-10-15', event: 'report_viewed', events: 1 },
        { day: '2026-10-15', event: 'share_clicked', events: 1 },
      ]);
    } finally {
      s.close();
    }
  });

  it('dedupes report views within the 30-minute (session, profile) window', async () => {
    const s = fresh();
    try {
      const t0 = '2026-10-15T12:00:00.000Z';
      let n = 0;
      const at = (iso: string, over: Partial<FunnelEventRecord> = {}) =>
        ev({ id: `fe-v-${(n += 1)}`, event: 'report_viewed', sessionRef: 'sid-x', profileId: P1, createdAt: iso, ...over });

      // 首次：插入。
      expect(await s.repo.recordView(at(t0), FUNNEL_VIEW_DEDUPE_WINDOW_MS)).toBe('inserted');
      // +10 分钟同 (session, profile)：去重。
      expect(
        await s.repo.recordView(at('2026-10-15T12:10:00.000Z'), FUNNEL_VIEW_DEDUPE_WINDOW_MS),
      ).toBe('deduped');
      // +10 分钟同 session 不同 profile：不去重。
      expect(
        await s.repo.recordView(
          at('2026-10-15T12:10:00.000Z', { profileId: P2 }),
          FUNNEL_VIEW_DEDUPE_WINDOW_MS,
        ),
      ).toBe('inserted');
      // +31 分钟同 (session, profile)：滑出窗口，重新计数。
      expect(
        await s.repo.recordView(at('2026-10-15T12:31:00.000Z'), FUNNEL_VIEW_DEDUPE_WINDOW_MS),
      ).toBe('inserted');
      // 无会话标识（sessionRef null）：永不去重，连续两次都直插。
      expect(
        await s.repo.recordView(at(t0, { sessionRef: null }), FUNNEL_VIEW_DEDUPE_WINDOW_MS),
      ).toBe('inserted');
      expect(
        await s.repo.recordView(at(t0, { sessionRef: null }), FUNNEL_VIEW_DEDUPE_WINDOW_MS),
      ).toBe('inserted');

      const rows = await s.repo.summarize({ sinceIso: SINCE });
      const viewed = rows.find((r) => r.event === 'report_viewed')!;
      // inserted 4 条（t0 / P2 / +31min / null×1 组中 2 条），deduped 1 条未落库 → 共 6 - 1 = 5？逐个数：
      // t0 inserted、+10 deduped（不落）、+10 P2 inserted、+31 inserted、null 两次各 inserted = 5 条。
      expect(viewed.events).toBe(5);
      expect(viewed.distinctSessions).toBe(1); // 只有 sid-x
      expect(viewed.nullSessions).toBe(2);
    } finally {
      s.close();
    }
  });

  it('only dedupes against report_viewed rows, not other events with the same session', async () => {
    const s = fresh();
    try {
      const t0 = '2026-10-15T12:00:00.000Z';
      // 同 (session, profile) 但事件是 analyze_enqueued：不应影响 report_viewed 去重。
      await s.repo.insert(
        ev({ id: 'fe-other', event: 'analyze_enqueued', sessionRef: 'sid-y', profileId: P1, createdAt: t0 }),
      );
      const view = ev({ id: 'fe-view', event: 'report_viewed', sessionRef: 'sid-y', profileId: P1, createdAt: t0 });
      expect(await s.repo.recordView(view, FUNNEL_VIEW_DEDUPE_WINDOW_MS)).toBe('inserted');
    } finally {
      s.close();
    }
  });
});

describe('createFunnelRecorder', () => {
  function capturingRepo(): IFunnelEventsRepository & {
    rows: FunnelEventRecord[];
    recordViewCalls: Array<{ row: FunnelEventRecord; windowMs: number }>;
  } {
    return {
      rows: [],
      recordViewCalls: [],
      async insert(row) {
        this.rows.push(row);
      },
      async recordView(row, windowMs) {
        this.recordViewCalls.push({ row, windowMs });
        return 'inserted';
      },
      async summarize() {
        return [];
      },
      async summarizeDaily() {
        return [];
      },
    };
  }

  const input: RecordFunnelInput = {
    event: 'share_clicked',
    sessionRef: 'sid-1',
    profileId: P1,
  };

  it('injects a fe- id and UTC ISO createdAt, normalizing omitted optionals to null', async () => {
    const repo = capturingRepo();
    const recorder = createFunnelRecorder(repo);
    await recorder.record({ event: 'analyze_cache_hit', sessionRef: null });

    expect(repo.rows).toHaveLength(1);
    const row = repo.rows[0]!;
    expect(row.id).toMatch(/^fe-[0-9a-f-]{36}$/);
    expect(row.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(row).toMatchObject({
      event: 'analyze_cache_hit',
      sessionRef: null,
      profileId: null,
      requester: null,
    });
  });

  it('routes report views through recordView with the 30-minute dedupe window', async () => {
    const repo = capturingRepo();
    const recorder = createFunnelRecorder(repo);
    await recorder.recordView({ ...input, event: 'report_viewed', requester: 'visitor' });

    expect(repo.recordViewCalls).toHaveLength(1);
    expect(repo.recordViewCalls[0]!.windowMs).toBe(30 * 60 * 1000);
    expect(repo.recordViewCalls[0]!.row).toMatchObject({
      event: 'report_viewed',
      sessionRef: 'sid-1',
      profileId: P1,
      requester: 'visitor',
    });
    expect(repo.rows).toHaveLength(0);
  });

  it('is fail-open: a throwing repository only logs and never rejects', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const broken: IFunnelEventsRepository = {
      async insert() {
        throw new Error('no such table: funnel_events');
      },
      async recordView() {
        return 'inserted';
      },
      async summarize() {
        return [];
      },
      async summarizeDaily() {
        return [];
      },
    };
    try {
      await expect(createFunnelRecorder(broken).record(input)).resolves.toBeUndefined();
      expect(spy).toHaveBeenCalledOnce();
      expect(String(spy.mock.calls[0]![0])).toContain('[funnel]');
      expect(String(spy.mock.calls[0]![1])).toContain('share_clicked');
    } finally {
      spy.mockRestore();
    }
  });

  it('degrades to a plain insert when the dedupe read fails (rather record twice than lose the view)', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const repo = capturingRepo();
    repo.recordView = async () => {
      throw new Error('dedupe read failed');
    };
    try {
      const recorder = createFunnelRecorder(repo);
      await expect(
        recorder.recordView({ ...input, event: 'report_viewed' }),
      ).resolves.toBeUndefined();
      // recordView 抛错 → fallback 直插一条，事件不丢。
      expect(repo.rows).toHaveLength(1);
      expect(repo.rows[0]!.event).toBe('report_viewed');
    } finally {
      spy.mockRestore();
    }
  });

  it('null recorder accepts anything without side effects', async () => {
    const n = createNullFunnelRecorder();
    await expect(n.record(input)).resolves.toBeUndefined();
    await expect(n.recordView({ ...input, event: 'report_viewed' })).resolves.toBeUndefined();
  });
});

describe('funnel privacy contract', () => {
  it('record rows and recorder input carry no account/ip/login/UA fields', () => {
    const row = ev({ id: 'fe-p', event: 'share_clicked', createdAt: SINCE });
    expect(Object.keys(row).sort()).toEqual([
      'createdAt',
      'event',
      'id',
      'profileId',
      'requester',
      'sessionRef',
    ]);
    // 隐私由 schema 层保证：入参结构里根本没有这些键可填。
    expect(Object.keys(RecordFunnelInputSchema.shape).sort()).toEqual([
      'event',
      'profileId',
      'requester',
      'sessionRef',
    ]);
  });
});
