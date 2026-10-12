import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runMigrations } from './sqlite/migrator.js';
import { openSqlite } from './sqlite/connection.js';
import { SqliteJobRunsRepository } from './sqlite/job-runs-repo.js';
import { SqliteJobRunEventsRepository } from './sqlite/job-run-events-repo.js';
import { SqliteSubmitIntentsRepository } from './sqlite/submit-intents-repo.js';
import {
  toStoredJobRun,
  type MatchReport,
  type NewJobRun,
  type NewJobRunEvent,
  type NewSubmitIntent,
  type RawJobRunRow,
  type SubmitIntentJob,
} from './entities/index.js';

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../db/migrations/sqlite',
);

function freshRepo(): {
  repo: SqliteJobRunsRepository;
  events: SqliteJobRunEventsRepository;
  intents: SqliteSubmitIntentsRepository;
  close: () => void;
} {
  const { client, db } = openSqlite(':memory:');
  runMigrations(client, MIGRATIONS_DIR);
  return {
    repo: new SqliteJobRunsRepository(db),
    events: new SqliteJobRunEventsRepository(db),
    intents: new SqliteSubmitIntentsRepository(db),
    close: () => client.close(),
  };
}

const JOB: SubmitIntentJob = {
  jobId: 'job-1',
  source: 'remoteok',
  sourceUrl: 'https://remoteok.com/remote-jobs/1',
  title: 'Senior Backend Engineer',
  company: 'Acme',
  location: 'Remote',
  remote: true,
  tags: ['go'],
  postedAt: '2026-10-01T00:00:00.000Z',
};

const REPORT: MatchReport = {
  ruleVersion: '0.1',
  score: 6,
  tier: 'high',
  fieldScores: { title: 3, tags: 2, description: 1 },
  matchedSkills: ['go'],
  reasons: [{ code: 'title_match', skill: 'go', points: 3 }],
  gaps: [],
  suggestedBoost: [],
};

function generatedIntent(id: string, createdAt: string, runId = 'run-1'): NewSubmitIntent {
  return {
    id,
    runId,
    accountId: 'acc-1',
    profileId: 'prof-1',
    jobId: `job-${id}`,
    jobSource: 'remoteok',
    job: { ...JOB, jobId: `job-${id}`, sourceUrl: `https://remoteok.com/remote-jobs/${id}` },
    matchScore: 6,
    matchTier: 'high',
    report: REPORT,
    createdAt,
    updatedAt: createdAt,
  };
}

function run(
  overrides: Partial<NewJobRun> & Pick<NewJobRun, 'id' | 'accountId'>,
): NewJobRun {
  return {
    profileId: 'prof-1',
    preferenceId: 'pref-1',
    createdAt: '2026-10-03T00:00:00.000Z',
    ...overrides,
  };
}

const T1 = '2026-10-03T01:00:00.000Z';
const T2 = '2026-10-03T02:00:00.000Z';

describe('SqliteJobRunsRepository', () => {
  it('inserts in created state with zero attempts and no scan cursor', async () => {
    const { repo, close } = freshRepo();
    await repo.insert(
      run({ id: 'run-1', accountId: 'acc-1', profileId: 'prof-9', preferenceId: 'pref-9' }),
    );

    const stored = await repo.getById('run-1');
    expect(stored).toBeDefined();
    expect(stored!.status).toBe('created');
    expect(stored!.attempts).toBe(0);
    expect(stored!.lastError).toBeNull();
    expect(stored!.lastScanAt).toBeNull();
    expect(stored!.profileId).toBe('prof-9');
    expect(stored!.preferenceId).toBe('pref-9');
    expect(stored!.updatedAt).toBe('2026-10-03T00:00:00.000Z');
    close();
  });

  it('compareAndSetStatus succeeds once and refuses a stale expectation', async () => {
    const { repo, close } = freshRepo();
    await repo.insert(run({ id: 'run-1', accountId: 'acc-1' }));

    const configured = await repo.compareAndSetStatus('run-1', 'created', {
      status: 'configured',
      attempts: 1,
      lastScanAt: T1,
      updatedAt: T1,
    });
    expect(configured).toBeDefined();
    expect(configured!.status).toBe('configured');
    expect(configured!.attempts).toBe(1);
    expect(configured!.lastScanAt).toBe(T1);

    // 第二个持有陈旧期望的调用者（cron 与手动触发撞车的那一方）拿不到行
    const stale = await repo.compareAndSetStatus('run-1', 'created', {
      status: 'watching',
      updatedAt: T2,
    });
    expect(stale).toBeUndefined();
    expect((await repo.getById('run-1'))!.status).toBe('configured');

    // 未知 id 同样返回 undefined
    expect(
      await repo.compareAndSetStatus('run-missing', 'created', {
        status: 'configured',
        updatedAt: T2,
      }),
    ).toBeUndefined();
    close();
  });

  it('compareAndSetStatusWithEvent commits the audit event with the CAS', async () => {
    const { repo, events, close } = freshRepo();
    await repo.insert(run({ id: 'run-1', accountId: 'acc-1' }));

    const event: NewJobRunEvent = {
      id: 'evt-1',
      runId: 'run-1',
      event: 'start',
      fromStatus: 'created',
      toStatus: 'watching',
      actor: 'system',
      createdAt: T1,
    };
    const moved = await repo.compareAndSetStatusWithEvent('run-1', 'created', {
      status: 'watching',
      updatedAt: T1,
    }, event);
    expect(moved).toBeDefined();
    expect(moved!.status).toBe('watching');

    // 赢家：事件与状态在同一事务落库，事件流可回放
    const page = await events.listLatestPage('run-1');
    expect(page.hasMore).toBe(false);
    expect(page.events).toHaveLength(1);
    expect(page.events[0]!).toMatchObject({
      id: 'evt-1',
      runId: 'run-1',
      event: 'start',
      fromStatus: 'created',
      toStatus: 'watching',
      actor: 'system',
    });

    // 输家（陈旧期望）：拿不到行，也不得留下审计事件
    const stale = await repo.compareAndSetStatusWithEvent(
      'run-1',
      'created',
      { status: 'recommending', updatedAt: T2 },
      { ...event, id: 'evt-2', event: 'candidates_ready', toStatus: 'recommending', createdAt: T2 },
    );
    expect(stale).toBeUndefined();
    expect((await events.listLatestPage('run-1')).events).toHaveLength(1);

    // 未知 id 同样零事件
    expect(
      await repo.compareAndSetStatusWithEvent(
        'run-missing',
        'created',
        { status: 'watching', updatedAt: T2 },
        { ...event, id: 'evt-3', runId: 'run-missing' },
      ),
    ).toBeUndefined();
    expect((await events.listLatestPage('run-missing')).events).toHaveLength(0);
    close();
  });

  it('publishGeneratedIntents commits run, tickets and the generated event atomically', async () => {
    const { repo, events, intents, close } = freshRepo();
    await repo.insert(run({ id: 'run-1', accountId: 'acc-1' }));
    await repo.insert(run({ id: 'run-2', accountId: 'acc-1' }));
    // run-1 已到 recommending；run-2 还停在 watching（持陈旧期望的那一方）
    await repo.compareAndSetStatus('run-1', 'created', { status: 'recommending', updatedAt: T1 });
    await repo.compareAndSetStatus('run-2', 'created', { status: 'watching', updatedAt: T1 });

    const winner = await repo.publishGeneratedIntents(
      'run-1',
      'recommending',
      { status: 'awaiting_approval', updatedAt: T2 },
      {
        id: 'evt-gen-1',
        runId: 'run-1',
        event: 'generated',
        fromStatus: 'recommending',
        toStatus: 'awaiting_approval',
        actor: 'agent',
        createdAt: T2,
        payload: { candidates: 2 },
      },
      [generatedIntent('intent-a', T2), generatedIntent('intent-b', T2)],
    );
    expect(winner).toBeDefined();
    expect(winner!.status).toBe('awaiting_approval');

    // 三表一致：run 推进、票据齐了、generated 事件恰好一条
    const tickets = await intents.listByRun('run-1');
    expect(tickets.map((x) => x.id).sort()).toEqual(['intent-a', 'intent-b']);
    expect(tickets.every((x) => x.status === 'pending')).toBe(true);
    const page = await events.listLatestPage('run-1');
    expect(page.events).toHaveLength(1);
    expect(page.events[0]!.event).toBe('generated');
    expect(page.events[0]!.payload).toEqual({ candidates: 2 });

    // 输家：CAS 0 行 → undefined，且零票据、零事件（不得留孤儿）
    const loser = await repo.publishGeneratedIntents(
      'run-2',
      'recommending',
      { status: 'awaiting_approval', updatedAt: T2 },
      {
        id: 'evt-gen-2',
        runId: 'run-2',
        event: 'generated',
        fromStatus: 'recommending',
        toStatus: 'awaiting_approval',
        actor: 'agent',
        createdAt: T2,
      },
      [generatedIntent('intent-c', T2, 'run-2')],
    );
    expect(loser).toBeUndefined();
    expect((await repo.getById('run-2'))!.status).toBe('watching');
    expect(await intents.listByRun('run-2')).toHaveLength(0);
    expect((await events.listLatestPage('run-2')).events).toHaveLength(0);
    close();
  });

  it('compareAndSetStatus can record an explicit failure reason', async () => {
    const { repo, close } = freshRepo();
    await repo.insert(run({ id: 'run-1', accountId: 'acc-1' }));
    const failed = await repo.compareAndSetStatus('run-1', 'created', {
      status: 'failed',
      attempts: 3,
      lastError: 'source unavailable',
      updatedAt: T2,
    });
    expect(failed!.status).toBe('failed');
    expect(failed!.lastError).toBe('source unavailable');
    expect(failed!.attempts).toBe(3);
    close();
  });

  it('setStatus advances unconditionally and reports a missing row', async () => {
    const { repo, close } = freshRepo();
    await repo.insert(run({ id: 'run-1', accountId: 'acc-1' }));

    const archived = await repo.setStatus('run-1', { status: 'archived', updatedAt: T2 });
    expect(archived!.status).toBe('archived');
    // 无条件推进：从终态再推进也照写（调用方负责语义，见接口注释）
    const cancelled = await repo.setStatus('run-1', { status: 'cancelled', updatedAt: T2 });
    expect(cancelled!.status).toBe('cancelled');

    expect(await repo.setStatus('run-missing', { status: 'archived', updatedAt: T2 })).toBeUndefined();
    close();
  });

  it('markViewed writes last_viewed_at without touching status or updated_at', async () => {
    const { repo, close } = freshRepo();
    await repo.insert(run({ id: 'run-1', accountId: 'acc-1' }));
    await repo.compareAndSetStatus('run-1', 'created', {
      status: 'awaiting_approval',
      updatedAt: T1,
    });

    const viewed = await repo.markViewed('run-1', T2);
    expect(viewed!.lastViewedAt).toBe(T2);
    // 查看不是状态迁移：状态与 updated_at 都不变，调度排序不受影响
    expect(viewed!.status).toBe('awaiting_approval');
    expect(viewed!.updatedAt).toBe(T1);

    expect(await repo.markViewed('run-missing', T2)).toBeUndefined();
    close();
  });

  it('listByStatuses filters, orders NULL last_scan_at first and honours limit', async () => {
    const { repo, close } = freshRepo();
    await repo.insert(run({ id: 'run-a', accountId: 'acc-1' }));
    await repo.insert(run({ id: 'run-b', accountId: 'acc-1' }));
    await repo.insert(run({ id: 'run-c', accountId: 'acc-1' }));
    await repo.insert(run({ id: 'run-d', accountId: 'acc-1' }));

    // run-a/run-b 都在 watching；a 从未扫描（last_scan_at = NULL），b 已扫过
    expect(
      (await repo.compareAndSetStatus('run-a', 'created', { status: 'watching', updatedAt: T1 }))!
        .status,
    ).toBe('watching');
    await repo.compareAndSetStatus('run-b', 'created', {
      status: 'watching',
      lastScanAt: T1,
      updatedAt: T1,
    });
    await repo.compareAndSetStatus('run-c', 'created', {
      status: 'watching',
      lastScanAt: '2026-10-03T00:30:00.000Z',
      updatedAt: T1,
    });
    await repo.compareAndSetStatus('run-d', 'created', { status: 'archived', updatedAt: T1 });

    const watching = await repo.listByStatuses(['watching']);
    // NULL（从未扫描）最前，其余按 last_scan_at 升序
    expect(watching.map((r) => r.id)).toEqual(['run-a', 'run-c', 'run-b']);

    const limited = await repo.listByStatuses(['watching'], 2);
    expect(limited.map((r) => r.id)).toEqual(['run-a', 'run-c']);

    const multi = await repo.listByStatuses(['watching', 'archived'], 10);
    expect(multi.map((r) => r.id)).toContain('run-d');
    expect(multi).toHaveLength(4);

    expect(await repo.listByStatuses([], 10)).toEqual([]);
    close();
  });

  it('listByAccount is newest-first and account-scoped', async () => {
    const { repo, close } = freshRepo();
    await repo.insert(
      run({ id: 'run-old', accountId: 'acc-1', createdAt: '2026-10-01T00:00:00.000Z' }),
    );
    await repo.insert(
      run({ id: 'run-new', accountId: 'acc-1', createdAt: '2026-10-02T00:00:00.000Z' }),
    );
    await repo.insert(
      run({ id: 'run-other', accountId: 'acc-2', createdAt: '2026-10-05T00:00:00.000Z' }),
    );

    const rows = await repo.listByAccount('acc-1');
    expect(rows.map((r) => r.id)).toEqual(['run-new', 'run-old']);
    close();
  });

  it('maps an unknown status to failed instead of pretending success', () => {
    const row: RawJobRunRow = {
      id: 'run-1',
      accountId: 'acc-1',
      profileId: 'prof-1',
      preferenceId: 'pref-1',
      status: 'not_a_status',
      attempts: 2,
      lastError: null,
      lastScanAt: null,
      createdAt: T1,
      updatedAt: T1,
    };
    expect(toStoredJobRun(row).status).toBe('failed');
    expect(toStoredJobRun({ ...row, status: 'awaiting_approval' }).status).toBe('awaiting_approval');
  });
});
