import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AbilityProfile } from '@jobagent/shared';
import { createStorage } from './storage.js';
import type { StorageContext } from './types.js';

/**
 * Postgres 仓储行为测试——只在提供 DATABASE_TEST_URL 时运行，否则整体 skip。
 *
 * 本地/CI 起一个一次性 Postgres 后执行：
 *   DATABASE_TEST_URL=postgres://user:pass@localhost:5432/jobagent_test pnpm --filter @jobagent/storage test
 *
 * 断言与 SQLite 行为测试对齐，验证同一 I*Repository 契约在真实 Postgres 上成立
 * （async 事务认领、boolean/integer 列、JSON 文本列往返、唯一约束）。
 */

const url = process.env.DATABASE_TEST_URL;
const describeIfPg = url ? describe : describe.skip;

function minimalSnapshot(login: string): AbilityProfile {
  return {
    profileId: `prof_${randomUUID().replace(/-/g, '')}`,
    analyzerVersion: 'schema-0.1-engine-0.1.0',
    generatedAt: '2026-09-11T00:00:00.000Z',
    dataWindow: { since: '2025-09-11T00:00:00.000Z', until: '2026-09-11T00:00:00.000Z' },
    analysisLayers: ['L0', 'L1'],
    subject: { platform: 'github', login, profileUrl: `https://github.com/${login}`, claimed: false },
    summary: { headline: 'PG behavior test' },
    skillTags: [],
    activity: { longevityMonths: 12 },
    collaboration: { evidenceRefs: [] },
    authenticity: { status: 'likely_authentic', confidence: 0.8, signals: [] },
    interviewQuestions: [],
    caveats: [],
  } as unknown as AbilityProfile;
}

describeIfPg('postgres repositories (DATABASE_TEST_URL)', () => {
  let storage: StorageContext;

  beforeAll(async () => {
    storage = await createStorage({
      driver: 'postgres',
      databaseUrl: url!,
      autoMigrate: true,
    });
  });

  afterAll(async () => {
    await storage.close();
  });

  it('creates, claims FIFO and succeeds a job', async () => {
    const suffix = randomUUID().slice(0, 8);
    const oldId = `job_old_${suffix}`;
    const newId = `job_new_${suffix}`;
    await storage.jobs.create({ id: oldId, subjectLogin: `u_${suffix}` });
    await storage.jobs.create({ id: newId, subjectLogin: `u_${suffix}` });

    const first = await storage.jobs.claimNext('pg-test-worker');
    expect(first?.id).toBe(oldId);
    expect(first?.status).toBe('running');
    expect(first?.attempts).toBe(1);

    const second = await storage.jobs.claimNext('pg-test-worker');
    expect(second?.id).toBe(newId);

    await storage.jobs.succeed(oldId, `prof_ok_${suffix}`, { graphqlPoints: 3 }, []);
    const done = await storage.jobs.getById(oldId);
    expect(done?.status).toBe('succeeded');
    expect(done?.profileId).toBe(`prof_ok_${suffix}`);
    expect(done?.budgetUsed).toEqual({ graphqlPoints: 3 });
  });

  it('inserts and reads back a profile with boolean and JSON round-trip', async () => {
    const id = `prof_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
    const snapshot = minimalSnapshot(`pg_${randomUUID().slice(0, 6)}`);
    await storage.profiles.insert({
      id,
      analyzerVersion: snapshot.analyzerVersion,
      subjectLogin: snapshot.subject.login,
      subjectClaimed: true,
      dataWindowSince: snapshot.dataWindow.since,
      dataWindowUntil: snapshot.dataWindow.until,
      status: 'complete',
      snapshot,
    });
    const stored = await storage.profiles.getById(id);
    expect(stored?.subjectClaimed).toBe(true);
    expect(stored?.status).toBe('complete');
    expect(stored?.analysisLayers).toEqual(['L0', 'L1']);
    expect(stored?.snapshot?.subject.login).toBe(snapshot.subject.login);
  });

  it('batch-inserts evidence and counts by profile', async () => {
    const profileId = `prof_ev_${randomUUID().slice(0, 8)}`;
    await storage.evidence.insertBatch([
      { id: `ev_${randomUUID()}`, profileId, sourceType: 'commit', url: 'https://x/1', layer: 'L1', claim: 'c1', rawRef: 'a' },
      { id: `ev_${randomUUID()}`, profileId, sourceType: 'pr', url: 'https://x/2', layer: 'L1', claim: 'c2', rawRef: 'b' },
    ]);
    expect(await storage.evidence.countByProfile(profileId)).toBe(2);
    expect((await storage.evidence.listByProfile(profileId))).toHaveLength(2);
  });

  it('rejects duplicate waitlist email', async () => {
    const email = `pg_${randomUUID().slice(0, 8)}@example.com`;
    await storage.waitlist.insert({ id: `wl_${randomUUID()}`, email });
    await expect(
      storage.waitlist.insert({ id: `wl_${randomUUID()}`, email }),
    ).rejects.toThrow();
  });
});
