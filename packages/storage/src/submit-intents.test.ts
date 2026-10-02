import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runMigrations } from './sqlite/migrator.js';
import { openSqlite } from './sqlite/connection.js';
import { SqliteApplicationsRepository } from './sqlite/applications-repo.js';
import { SqliteSubmitIntentsRepository } from './sqlite/submit-intents-repo.js';
import {
  toStoredSubmitIntent,
  type MatchReport,
  type NewSubmitIntent,
  type RawSubmitIntentRow,
  type SubmitIntentJob,
} from './entities/index.js';

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../db/migrations/sqlite',
);

function freshRepo(): {
  repo: SqliteSubmitIntentsRepository;
  applications: SqliteApplicationsRepository;
  close: () => void;
} {
  const { client, db } = openSqlite(':memory:');
  runMigrations(client, MIGRATIONS_DIR);
  return {
    repo: new SqliteSubmitIntentsRepository(db),
    applications: new SqliteApplicationsRepository(db),
    close: () => client.close(),
  };
}

const JOB: SubmitIntentJob = {
  jobId: 'job-1',
  source: 'remoteok',
  sourceUrl: 'https://remoteok.com/remote-jobs/1',
  applyUrl: 'https://remoteok.com/remote-jobs/1/apply',
  title: 'Senior Backend Engineer',
  company: 'Acme',
  location: 'Remote',
  remote: true,
  salaryMin: 150000,
  salaryMax: 200000,
  salaryCurrency: 'USD',
  tags: ['go', 'postgres'],
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

const T1 = '2026-10-03T01:00:00.000Z';
const T2 = '2026-10-03T02:00:00.000Z';
const T3 = '2026-10-03T03:00:00.000Z';

function intent(
  overrides: Partial<NewSubmitIntent> & Pick<NewSubmitIntent, 'id' | 'createdAt'>,
): NewSubmitIntent {
  return {
    runId: 'run-1',
    accountId: 'acc-1',
    profileId: 'prof-1',
    jobId: 'job-1',
    jobSource: 'remoteok',
    job: JOB,
    matchScore: 6,
    matchTier: 'high',
    report: REPORT,
    updatedAt: overrides.createdAt,
    ...overrides,
  };
}

function rawRow(overrides: Partial<RawSubmitIntentRow>): RawSubmitIntentRow {
  return {
    id: 'intent-x',
    runId: 'run-1',
    accountId: 'acc-1',
    profileId: 'prof-1',
    jobId: 'job-1',
    jobSource: 'remoteok',
    jobSnapshot: JSON.stringify(JOB),
    matchScore: 6,
    matchTier: 'high',
    matchReport: JSON.stringify(REPORT),
    status: 'pending',
    rejectReason: null,
    approvedAt: null,
    rejectedAt: null,
    submittedAt: null,
    applicationId: null,
    createdAt: T1,
    updatedAt: T1,
    ...overrides,
  };
}

describe('SqliteSubmitIntentsRepository', () => {
  it('inserts pending with null timestamps and round-trips both JSON snapshots', async () => {
    const { repo, close } = freshRepo();
    await repo.insert(intent({ id: 'intent-1', createdAt: T1 }));

    const stored = await repo.getById('intent-1');
    expect(stored).toBeDefined();
    expect(stored!.status).toBe('pending');
    expect(stored!.rejectReason).toBeNull();
    expect(stored!.approvedAt).toBeNull();
    expect(stored!.rejectedAt).toBeNull();
    expect(stored!.submittedAt).toBeNull();
    expect(stored!.applicationId).toBeNull();
    expect(stored!.jobSource).toBe('remoteok');
    expect(stored!.matchScore).toBe(6);
    expect(stored!.matchTier).toBe('high');
    // 快照逐字段往返（不是存了个引用：JSON 列是真落库的文本）
    expect(stored!.job).toEqual(JOB);
    expect(stored!.report).toEqual(REPORT);
    close();
  });

  it('insertMany is a no-op on an empty list and lists newest-first per run', async () => {
    const { repo, close } = freshRepo();
    await repo.insertMany([]);
    await repo.insertMany([
      intent({ id: 'intent-old', createdAt: T1 }),
      intent({ id: 'intent-new', createdAt: T3 }),
      intent({ id: 'intent-mid', createdAt: T2 }),
      intent({ id: 'intent-other', runId: 'run-2', createdAt: T3 }),
    ]);

    const rows = await repo.listByRun('run-1');
    expect(rows.map((r) => r.id)).toEqual(['intent-new', 'intent-mid', 'intent-old']);
    expect((await repo.listByRun('run-1', 1)).map((r) => r.id)).toEqual(['intent-new']);

    await repo.approveMany('run-1', ['intent-old'], T3);
    await repo.reject('intent-mid', 'too junior', T3);
    const approved = await repo.listByRunAndStatus('run-1', 'approved');
    expect(approved.map((r) => r.id)).toEqual(['intent-old']);
    const rejected = await repo.listByRunAndStatus('run-1', 'rejected');
    expect(rejected.map((r) => r.id)).toEqual(['intent-mid']);
    expect(rejected[0]!.rejectReason).toBe('too junior');
    close();
  });

  it('approveMany only moves pending rows of that run and returns the moved count', async () => {
    const { repo, close } = freshRepo();
    await repo.insertMany([
      intent({ id: 'intent-a', createdAt: T1 }),
      intent({ id: 'intent-b', createdAt: T2 }),
      intent({ id: 'intent-c', createdAt: T3 }),
      intent({ id: 'intent-other-run', runId: 'run-2', createdAt: T1 }),
    ]);
    // c 先被拒绝：不应被后续 approveMany 复活
    await repo.reject('intent-c', null, T3);

    const moved = await repo.approveMany('run-1', ['intent-a', 'intent-b', 'intent-c'], T3);
    expect(moved).toBe(2);
    expect((await repo.getById('intent-a'))!.status).toBe('approved');
    expect((await repo.getById('intent-a'))!.approvedAt).toBe(T3);
    expect((await repo.getById('intent-b'))!.status).toBe('approved');
    expect((await repo.getById('intent-c'))!.status).toBe('rejected');
    // 另一个 run 的同名 id 不在作用域内
    expect((await repo.getById('intent-other-run'))!.status).toBe('pending');

    // 已经 approved 的行不再是 pending → 第二次调用移动 0 行
    expect(await repo.approveMany('run-1', ['intent-a'], T3)).toBe(0);
    expect(await repo.approveMany('run-1', [], T3)).toBe(0);
    close();
  });

  it('reject is guarded to pending and records the reason', async () => {
    const { repo, close } = freshRepo();
    await repo.insert(intent({ id: 'intent-1', createdAt: T1 }));

    const rejected = await repo.reject('intent-1', 'wrong stack', T2);
    expect(rejected!.status).toBe('rejected');
    expect(rejected!.rejectReason).toBe('wrong stack');
    expect(rejected!.rejectedAt).toBe(T2);
    expect(rejected!.approvedAt).toBeNull();

    // 已结单不再改写；未知 id 亦返回 undefined
    expect(await repo.reject('intent-1', 'again', T3)).toBeUndefined();
    expect((await repo.getById('intent-1'))!.rejectReason).toBe('wrong stack');
    expect(await repo.reject('intent-missing', null, T3)).toBeUndefined();
    close();
  });

  it('markSubmitted accepts pending/approved only and back-fills applicationId', async () => {
    const { repo, close } = freshRepo();
    await repo.insertMany([
      intent({ id: 'intent-pending', createdAt: T1 }),
      intent({ id: 'intent-approved', createdAt: T2, status: 'approved', approvedAt: T2 }),
      intent({ id: 'intent-rejected', createdAt: T3, status: 'rejected', rejectedAt: T3 }),
    ]);

    const fromPending = await repo.markSubmitted('intent-pending', T3, 'app-1');
    expect(fromPending!.status).toBe('submitted');
    expect(fromPending!.submittedAt).toBe(T3);
    expect(fromPending!.applicationId).toBe('app-1');

    const fromApproved = await repo.markSubmitted('intent-approved', T3, null);
    expect(fromApproved!.status).toBe('submitted');
    expect(fromApproved!.applicationId).toBeNull();

    // 已拒绝的票不可复活
    expect(await repo.markSubmitted('intent-rejected', T3, 'app-2')).toBeUndefined();
    expect((await repo.getById('intent-rejected'))!.status).toBe('rejected');
    // 已投出的票重复标记也不动
    expect(await repo.markSubmitted('intent-pending', T3, 'app-3')).toBeUndefined();
    expect((await repo.getById('intent-pending'))!.applicationId).toBe('app-1');
    expect(await repo.markSubmitted('intent-missing', T3, null)).toBeUndefined();
    close();
  });

  it('countCommittedBySourceSince counts only approved/submitted rows in the window', async () => {
    const { repo, close } = freshRepo();
    const since = '2026-10-03T00:00:00.000Z';
    const before = '2026-10-02T23:00:00.000Z';
    await repo.insertMany([
      // 计入：approved 落在窗口内
      intent({ id: 'in-1', createdAt: T1, status: 'approved', approvedAt: T1 }),
      // 计入：approved 在窗口外，但 submitted 在窗口内
      intent({
        id: 'in-2',
        createdAt: T1,
        status: 'submitted',
        approvedAt: before,
        submittedAt: T2,
      }),
      // 不计入：两个时间戳都在窗口外
      intent({ id: 'out-window', createdAt: T1, status: 'approved', approvedAt: before }),
      // 不计入：尚未确认
      intent({ id: 'out-pending', createdAt: T1 }),
      // 不计入：已被拒绝（哪怕带 approvedAt 也不复活）
      intent({ id: 'out-rejected', createdAt: T1, status: 'rejected', rejectedAt: T2 }),
      // 不计入：已撤回
      intent({
        id: 'out-withdrawn',
        createdAt: T1,
        status: 'withdrawn',
        approvedAt: T1,
      }),
      // 不计入：来源不同
      intent({
        id: 'out-source',
        createdAt: T1,
        status: 'approved',
        approvedAt: T1,
        jobSource: 'greenhouse',
      }),
      // 不计入：账号不同
      intent({
        id: 'out-account',
        createdAt: T1,
        status: 'approved',
        approvedAt: T1,
        accountId: 'acc-2',
      }),
    ]);

    expect(await repo.countCommittedBySourceSince('acc-1', 'remoteok', since)).toBe(2);
    expect(await repo.countCommittedBySourceSince('acc-1', 'greenhouse', since)).toBe(1);
    expect(await repo.countCommittedBySourceSince('acc-2', 'remoteok', since)).toBe(1);
    expect(await repo.countCommittedBySourceSince('acc-1', 'remoteok', T3)).toBe(0);
    close();
  });

  it('links an application row back to its ticket through submit_intent_id', async () => {
    const { repo, applications, close } = freshRepo();
    await repo.insert(intent({ id: 'intent-1', createdAt: T1 }));
    await repo.markSubmitted('intent-1', T2, 'app-1');

    await applications.insert({
      id: 'app-1',
      profileId: 'prof-1',
      jobId: 'job-1',
      source: 'remoteok',
      targetTitle: 'Senior Backend Engineer',
      targetCompany: 'Acme',
      origin: 'agent',
      appliedAt: T2,
      submitIntentId: 'intent-1',
    });
    await applications.insert({
      id: 'app-2',
      profileId: 'prof-1',
      targetTitle: 'Manual',
      targetCompany: 'Beta',
      appliedAt: T2,
    });

    const linked = (await applications.getById('app-1'))!;
    expect(linked.origin).toBe('agent');
    expect(linked.submitIntentId).toBe('intent-1');
    expect((await applications.getById('app-2'))!.submitIntentId).toBeNull();
    close();
  });

  it('degrades safely for unknown enum values and corrupt snapshots', () => {
    const unknown = toStoredSubmitIntent(
      rawRow({ jobSource: 'carrier_pigeon', status: 'maybe', matchTier: 'legendary' }),
    );
    expect(unknown.jobSource).toBe('manual');
    // 未知状态退回人机闸（绝不假装"已确认/已投"）
    expect(unknown.status).toBe('pending');
    expect(unknown.matchTier).toBe('low');

    const corrupt = toStoredSubmitIntent(
      rawRow({ jobSnapshot: 'not json', matchReport: '{' }),
    );
    expect(corrupt.job.title).toBe('');
    expect(corrupt.job.jobId).toBe('job-1');
    expect(corrupt.report.score).toBe(6);
    expect(corrupt.report.fieldScores).toEqual({ title: 0, tags: 0, description: 0 });
    expect(corrupt.report.reasons).toEqual([]);
  });
});
