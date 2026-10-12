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
  type NewApplication,
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

const T0 = '2026-10-03T00:00:00.000Z';
const T1 = '2026-10-03T01:00:00.000Z';
const T2 = '2026-10-03T02:00:00.000Z';
const T3 = '2026-10-03T03:00:00.000Z';

function application(id: string, overrides: Partial<NewApplication> = {}): NewApplication {
  return {
    id,
    profileId: 'prof-1',
    jobId: 'job-1',
    source: 'remoteok',
    targetTitle: 'Senior Backend Engineer',
    targetCompany: 'Acme',
    targetUrl: 'https://remoteok.com/remote-jobs/1/apply',
    origin: 'agent',
    appliedAt: T3,
    createdByAccountId: 'acc-1',
    submitIntentId: 'intent-1',
    ...overrides,
  };
}

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

  it('markSubmittedWithApplication commits the ticket CAS and the application row together', async () => {
    const { repo, applications, close } = freshRepo();
    await repo.insert(intent({ id: 'intent-1', createdAt: T1 }));

    const result = await repo.markSubmittedWithApplication('intent-1', application('app-1'), T3);
    expect(result.outcome).toBe('submitted');
    if (result.outcome !== 'submitted') throw new Error('expected submitted outcome');
    expect(result.intent.status).toBe('submitted');
    expect(result.intent.submittedAt).toBe(T3);
    expect(result.intent.applicationId).toBe('app-1');
    // application 行反向链回票据，origin 保留调用方给的 agent
    expect(result.application.submitIntentId).toBe('intent-1');
    expect(result.application.origin).toBe('agent');
    expect(await applications.listByProfile('prof-1')).toHaveLength(1);

    // 重复标记（即便带了另一个 application id）：幂等返回既有行，绝不插第二条
    const again = await repo.markSubmittedWithApplication(
      'intent-1',
      application('app-2'),
      T3,
    );
    expect(again.outcome).toBe('already');
    if (again.outcome !== 'already') throw new Error('expected already outcome');
    expect(again.intent.status).toBe('submitted');
    expect(again.intent.applicationId).toBe('app-1');
    expect(again.application!.id).toBe('app-1');
    expect(await applications.listByProfile('prof-1')).toHaveLength(1);
    close();
  });

  it('markSubmittedWithApplication reconciles a pre-035 orphan application without a duplicate', async () => {
    const { repo, applications, close } = freshRepo();
    // 035 之前的历史数据：application 已存在并回链，但票据还停在 pending
    await repo.insert(intent({ id: 'intent-orphan', createdAt: T1 }));
    await applications.insert(
      application('app-orphan', { submitIntentId: 'intent-orphan' }),
    );

    const result = await repo.markSubmittedWithApplication(
      'intent-orphan',
      application('app-new', { submitIntentId: 'intent-orphan' }),
      T3,
    );
    expect(result.outcome).toBe('already');
    if (result.outcome !== 'already') throw new Error('expected already outcome');
    // 票据被补齐为 submitted，既有 application 原样返回，不重插
    expect(result.intent.status).toBe('submitted');
    expect(result.intent.submittedAt).toBe(T3);
    expect(result.application!.id).toBe('app-orphan');
    const rows = await applications.listByProfile('prof-1');
    expect(rows.map((r) => r.id)).toEqual(['app-orphan']);
    close();
  });

  it('markSubmittedWithApplication rejects rejected and unknown tickets without writing an application', async () => {
    const { repo, applications, close } = freshRepo();
    await repo.insertMany([
      intent({ id: 'intent-rejected', createdAt: T1, status: 'rejected', rejectedAt: T2 }),
    ]);

    const fromRejected = await repo.markSubmittedWithApplication(
      'intent-rejected',
      application('app-1', { submitIntentId: 'intent-rejected' }),
      T3,
    );
    expect(fromRejected.outcome).toBe('invalid');
    expect((await repo.getById('intent-rejected'))!.status).toBe('rejected');

    const fromUnknown = await repo.markSubmittedWithApplication(
      'intent-missing',
      application('app-2', { submitIntentId: 'intent-missing' }),
      T3,
    );
    expect(fromUnknown.outcome).toBe('invalid');
    expect(await applications.listByProfile('prof-1')).toHaveLength(0);
    close();
  });

  it('approveManyWithQuota approves a whole batch when every source is within the limit', async () => {
    const { repo, close } = freshRepo();
    await repo.insertMany([
      intent({ id: 'intent-a', createdAt: T1 }),
      intent({ id: 'intent-b', createdAt: T2 }),
    ]);

    const result = await repo.approveManyWithQuota('run-1', 'acc-1', ['intent-a', 'intent-b'], 5, T0, T3);
    expect(result).toEqual({ outcome: 'approved', approved: 2 });
    for (const id of ['intent-a', 'intent-b']) {
      const stored = (await repo.getById(id))!;
      expect(stored.status).toBe('approved');
      expect(stored.approvedAt).toBe(T3);
    }

    // 空批是一次零成本 no-op
    expect(await repo.approveManyWithQuota('run-1', 'acc-1', [], 5, T0, T3)).toEqual({
      outcome: 'approved',
      approved: 0,
    });
    close();
  });

  it('approveManyWithQuota rolls back the whole batch when a source exceeds the limit', async () => {
    const { repo, close } = freshRepo();
    await repo.insertMany([
      // 窗口内已有一笔 remoteok 已确认：committed = 1
      intent({ id: 'intent-done', createdAt: T1, status: 'approved', approvedAt: T1 }),
      intent({ id: 'intent-a', createdAt: T2 }),
      intent({ id: 'intent-b', createdAt: T3 }),
    ]);

    const result = await repo.approveManyWithQuota(
      'run-1',
      'acc-1',
      ['intent-a', 'intent-b'],
      2,
      T0,
      T3,
    );
    // 1 + 2 > 2：整单失败，逐字段报额，绝不部分确认
    expect(result).toEqual({
      outcome: 'quota_exceeded',
      source: 'remoteok',
      committed: 1,
      remaining: 1,
      requested: 2,
    });
    for (const id of ['intent-a', 'intent-b']) {
      expect((await repo.getById(id))!.status).toBe('pending');
    }
    close();
  });

  it('approveManyWithQuota excludes already-processed tickets from the requested count', async () => {
    const { repo, close } = freshRepo();
    await repo.insertMany([
      intent({ id: 'intent-a', createdAt: T1 }),
      intent({ id: 'intent-b', createdAt: T2 }),
      // 已被拒绝：不在 pending 分组里，不占额度也不复活
      intent({ id: 'intent-rejected', createdAt: T3, status: 'rejected', rejectedAt: T3 }),
    ]);

    // limit=2：若把 rejected 算进请求数会是 3 > 2；实际 requested 只有 2，整批通过
    const result = await repo.approveManyWithQuota(
      'run-1',
      'acc-1',
      ['intent-a', 'intent-b', 'intent-rejected'],
      2,
      T0,
      T3,
    );
    expect(result).toEqual({ outcome: 'approved', approved: 2 });
    expect((await repo.getById('intent-rejected'))!.status).toBe('rejected');
    close();
  });

  it('approveManyWithQuota accounts for committed usage independently per source', async () => {
    const { repo, close } = freshRepo();
    await repo.insertMany([
      // greenhouse 窗口内已有一笔已确认
      intent({
        id: 'intent-gh-done',
        createdAt: T1,
        status: 'approved',
        approvedAt: T1,
        jobSource: 'greenhouse',
        job: { ...JOB, source: 'greenhouse' },
      }),
      intent({
        id: 'intent-gh-1',
        createdAt: T1,
        jobSource: 'greenhouse',
        job: { ...JOB, source: 'greenhouse' },
      }),
      intent({ id: 'intent-ro-1', createdAt: T2 }),
      intent({ id: 'intent-ro-2', createdAt: T3 }),
    ]);
    const ids = ['intent-gh-1', 'intent-ro-1', 'intent-ro-2'];

    // limit=1：greenhouse committed 1 + requested 1 > 1 → 整批回滚（含本可通过的 remoteok）
    const blocked = await repo.approveManyWithQuota('run-1', 'acc-1', ids, 1, T0, T3);
    expect(blocked).toEqual({
      outcome: 'quota_exceeded',
      source: 'greenhouse',
      committed: 1,
      remaining: 0,
      requested: 1,
    });
    for (const id of ids) {
      expect((await repo.getById(id))!.status).toBe('pending');
    }

    // 同批票据、limit=3：greenhouse 2 ≤ 3、remoteok 2 ≤ 3，逐源通过
    const passed = await repo.approveManyWithQuota('run-1', 'acc-1', ids, 3, T0, T3);
    expect(passed).toEqual({ outcome: 'approved', approved: 3 });
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
