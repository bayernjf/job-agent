import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runMigrations } from './sqlite/migrator.js';
import { openSqlite } from './sqlite/connection.js';
import { SqliteApplicationsRepository } from './sqlite/applications-repo.js';
import {
  APPLICATION_STAGES,
  APPLICATION_STATUSES,
  isAllowedStageTransition,
  type NewApplication,
  type NewApplicationEvent,
} from './entities/index.js';

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../db/migrations/sqlite',
);

function freshRepo(): { repo: SqliteApplicationsRepository; close: () => void } {
  const { client, db } = openSqlite(':memory:');
  runMigrations(client, MIGRATIONS_DIR);
  return { repo: new SqliteApplicationsRepository(db), close: () => client.close() };
}

function app(overrides: Partial<NewApplication> & Pick<NewApplication, 'id' | 'profileId'>): NewApplication {
  return {
    targetTitle: 'Senior Engineer',
    targetCompany: 'Acme',
    appliedAt: '2026-09-16T00:00:00.000Z',
    ...overrides,
  };
}

describe('SqliteApplicationsRepository', () => {
  it('inserts with defaults and reads back by id', async () => {
    const { repo, close } = freshRepo();
    await repo.insert(app({ id: 'app-1', profileId: 'prof-1' }));
    const stored = await repo.getById('app-1');
    expect(stored).toBeDefined();
    expect(stored!.status).toBe('applied');
    expect(stored!.origin).toBe('manual');
    expect(stored!.jobId).toBeNull();
    expect(stored!.targetUrl).toBeNull();
    expect(stored!.note).toBeNull();
    close();
  });

  it('records creator ownership and enforces it row-locally on update (#17-F11)', async () => {
    const { repo, close } = freshRepo();
    await repo.insert(app({ id: 'app-owned', profileId: 'prof-1', createdByAccountId: 'acc-a' }));
    await repo.insert(app({ id: 'app-anon', profileId: 'prof-1' }));

    expect((await repo.getById('app-owned'))!.createdByAccountId).toBe('acc-a');
    // 匿名/013 之前的历史行一律 null，不被回改成猜测值
    expect((await repo.getById('app-anon'))!.createdByAccountId).toBeNull();

    // 非主调用者：与"不存在"同形（undefined），且行内容不动
    expect(await repo.update('app-owned', { status: 'offer' }, 'acc-b')).toBeUndefined();
    expect((await repo.getById('app-owned'))!.status).toBe('applied');
    // 匿名调用者同样改不动有主行
    expect(await repo.update('app-owned', { status: 'offer' }, null)).toBeUndefined();
    // 本人改得动
    expect((await repo.update('app-owned', { status: 'offer' }, 'acc-a'))!.status).toBe('offer');
    // 无主行沿用现状：任何人可改（存量兼容，PRD F11 验收 1）
    expect((await repo.update('app-anon', { status: 'viewed' }, 'acc-b'))!.status).toBe('viewed');

    // 不传 scope = 不校验（仅内部推进路径可用，如 interviews 关联投递）
    expect((await repo.update('app-owned', { status: 'interview' }))!.status).toBe('interview');
    close();
  });

  it('lists applications for a profile ordered by applied_at desc, scoped to the profile', async () => {
    const { repo, close } = freshRepo();
    await repo.insert(
      app({ id: 'app-1', profileId: 'prof-1', appliedAt: '2026-09-01T00:00:00.000Z' }),
    );
    await repo.insert(
      app({ id: 'app-2', profileId: 'prof-1', appliedAt: '2026-09-10T00:00:00.000Z', status: 'interview' }),
    );
    await repo.insert(
      app({ id: 'app-3', profileId: 'prof-2', appliedAt: '2026-09-12T00:00:00.000Z' }),
    );
    const mine = await repo.listByProfile('prof-1');
    expect(mine.map((a) => a.id)).toEqual(['app-2', 'app-1']);
    expect(await repo.listByProfile('prof-2')).toHaveLength(1);
    close();
  });

  it('patches status and note, bumps updated_at, and keeps unknown statuses from leaking', async () => {
    const { repo, close } = freshRepo();
    await repo.insert(app({ id: 'app-1', profileId: 'prof-1' }));
    const before = (await repo.getById('app-1'))!.updatedAt;
    const updated = await repo.update('app-1', { status: 'offer', note: '终面通过' });
    expect(updated!.status).toBe('offer');
    expect(updated!.note).toBe('终面通过');
    expect(updated!.updatedAt >= before).toBe(true);
    expect(await repo.update('missing', { status: 'rejected' })).toBeUndefined();
    close();
  });

  it('exposes the full funnel status enum', () => {
    expect(APPLICATION_STATUSES).toEqual([
      'saved',
      'applied',
      'viewed',
      'interview',
      'offer',
      'rejected',
      'withdrawn',
    ]);
  });

  // ── B3-b（迁移 039）：招聘方 pipeline 阶段推进 ─────────────────────────────

  it('advances stage with CAS and writes the event in the same transaction', async () => {
    const { repo, close } = freshRepo();
    await repo.insert(app({ id: 'app-1', profileId: 'prof-1', jobId: 'posting-1' }));

    // 首次推进（expectStage=null → new）：成功且落事件
    const first = await repo.advanceStage(
      'app-1',
      null,
      'new',
      event('evt-1', 'app-1', null, 'new'),
    );
    expect(first!.stage).toBe('new');
    // CAS 输家：expectStage 已不是 null（此时 stage=new），返回 undefined 且零事件
    expect(await repo.advanceStage('app-1', null, 'screening', event('evt-x', 'app-1', null, 'screening'))).toBeUndefined();
    const eventsAfterFirst = await repo.listStageEvents('app-1');
    expect(eventsAfterFirst.map((e) => e.id)).toEqual(['evt-1']);

    // 正常推进 new → screening → interview
    const second = await repo.advanceStage(
      'app-1',
      'new',
      'screening',
      event('evt-2', 'app-1', 'new', 'screening'),
    );
    expect(second!.stage).toBe('screening');
    const third = await repo.advanceStage(
      'app-1',
      'screening',
      'interview',
      event('evt-3', 'app-1', 'screening', 'interview'),
    );
    expect(third!.stage).toBe('interview');

    // 事件流正序回放：from/to 完整
    const stream = await repo.listStageEvents('app-1');
    expect(stream.map((e) => [e.fromStage, e.toStage])).toEqual([
      [null, 'new'],
      ['new', 'screening'],
      ['screening', 'interview'],
    ]);
    // 只追加：再次读取仍是 3 条，不回改
    expect(await repo.listStageEvents('app-1')).toHaveLength(3);
    close();
  });

  it('keeps the event stream append-only and carries payload/actor', async () => {
    const { repo, close } = freshRepo();
    await repo.insert(app({ id: 'app-1', profileId: 'prof-1', jobId: 'posting-1' }));
    await repo.advanceStage(
      'app-1',
      null,
      'screening',
      event('evt-1', 'app-1', null, 'screening', { note: '简历初筛通过', postingId: 'posting-1' }),
    );
    await repo.advanceStage('app-1', 'screening', 'rejected', event('evt-2', 'app-1', 'screening', 'rejected', { note: '经验不匹配' }));
    const stream = await repo.listStageEvents('app-1');
    expect(stream).toHaveLength(2);
    expect(stream[0]!.actor).toBe('recruiter');
    expect(stream[0]!.payload).toEqual({ note: '简历初筛通过', postingId: 'posting-1' });
    expect(stream[1]!.toStage).toBe('rejected');
    close();
  });

  it('lists applications by job id (recruiter posting pipeline source)', async () => {
    const { repo, close } = freshRepo();
    await repo.insert(app({ id: 'app-1', profileId: 'prof-1', jobId: 'posting-1', appliedAt: '2026-09-01T00:00:00.000Z' }));
    await repo.insert(app({ id: 'app-2', profileId: 'prof-2', jobId: 'posting-1', appliedAt: '2026-09-10T00:00:00.000Z' }));
    await repo.insert(app({ id: 'app-3', profileId: 'prof-3' }));
    const onPosting = await repo.listByJobId('posting-1');
    expect(onPosting.map((a) => a.id)).toEqual(['app-2', 'app-1']);
    expect(await repo.listByJobId('posting-2')).toHaveLength(0);
    close();
  });

  it('deletes stage events when a profile is deleted (cascade, same transaction)', async () => {
    const { repo, close } = freshRepo();
    await repo.insert(app({ id: 'app-1', profileId: 'prof-1', jobId: 'posting-1' }));
    await repo.advanceStage('app-1', null, 'new', event('evt-1', 'app-1', null, 'new'));
    await repo.advanceStage('app-1', 'new', 'screening', event('evt-2', 'app-1', 'new', 'screening'));
    await repo.deleteByProfile('prof-1');
    expect(await repo.getById('app-1')).toBeUndefined();
    expect(await repo.listStageEvents('app-1')).toHaveLength(0);
    close();
  });

  it('defines a valid, one-way stage machine with terminal hired/rejected', () => {
    expect(APPLICATION_STAGES).toEqual(['new', 'screening', 'interview', 'offer', 'hired', 'rejected']);
    // 首推进任意阶段合法
    for (const stage of APPLICATION_STAGES) {
      expect(isAllowedStageTransition(null, stage)).toBe(true);
    }
    // 正向推进合法
    expect(isAllowedStageTransition('new', 'screening')).toBe(true);
    expect(isAllowedStageTransition('screening', 'interview')).toBe(true);
    expect(isAllowedStageTransition('interview', 'offer')).toBe(true);
    expect(isAllowedStageTransition('offer', 'hired')).toBe(true);
    // 任意阶段可 reject
    for (const stage of ['new', 'screening', 'interview', 'offer'] as const) {
      expect(isAllowedStageTransition(stage, 'rejected')).toBe(true);
    }
    // 回退与跳级非法
    expect(isAllowedStageTransition('interview', 'new')).toBe(false);
    expect(isAllowedStageTransition('new', 'interview')).toBe(false);
    expect(isAllowedStageTransition('new', 'hired')).toBe(false);
    // 终态不可再迁移
    expect(isAllowedStageTransition('hired', 'rejected')).toBe(false);
    expect(isAllowedStageTransition('rejected', 'new')).toBe(false);
    expect(isAllowedStageTransition('rejected', 'rejected')).toBe(false);
  });
});

function event(
  id: string,
  applicationId: string,
  fromStage: NewApplicationEvent['fromStage'],
  toStage: NewApplicationEvent['toStage'],
  payload?: Record<string, unknown>,
): NewApplicationEvent {
  return {
    id,
    applicationId,
    event: 'stage_change',
    fromStage,
    toStage,
    actor: 'recruiter',
    ...(payload ? { payload } : {}),
    createdAt: '2026-10-14T10:00:00.000Z',
  };
}
