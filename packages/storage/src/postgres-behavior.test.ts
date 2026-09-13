import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, type TestContext } from 'vitest';
import type { AbilityProfile } from '@jobagent/shared';
import EmbeddedPostgres from 'embedded-postgres';
import { createStorage } from './storage.js';
import type { StorageContext } from './types.js';

/**
 * Postgres 仓储行为测试——在真实 Postgres 上验证同一 I*Repository 契约
 * （async 事务认领、boolean/integer 列、JSON 文本列往返、唯一约束）。
 *
 * 数据源优先级：
 * 1. 外部 DATABASE_TEST_URL 环境变量（CI/Docker 提供真实 PG）
 * 2. 自动启动 embedded-postgres（本地开发，无需安装 PG/Docker）
 * embedded PG 是异步启动的，模块加载时无法判断可用性，因此用例始终注册，
 * 在运行时（beforeAll 已跑完）通过 TestContext.skip() 跳过。
 */

const EMBEDDED_DIR = resolve(process.cwd(), 'data', 'pg-test-embedded');
const EMBEDDED_PORT = 5433;

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

describe('postgres repositories (embedded or DATABASE_TEST_URL)', () => {
  let storage: StorageContext | undefined;
  let embedded: EmbeddedPostgres | null = null;
  // 非 null 表示 PG 不可用；beforeAll 之后才确定
  let unavailable: string | null = null;

  // 包装：运行时（beforeAll 后）判断 PG 是否可用，不可用则跳过
  function pgIt(name: string, fn: (s: StorageContext, ctx: TestContext) => Promise<void>): void {
    it(name, (ctx) => {
      if (unavailable || !storage) {
        ctx.skip();
        return;
      }
      return fn(storage, ctx);
    });
  }

  beforeAll(async () => {
    let pgUrl: string | undefined;
    // 1. 优先使用外部 PG
    if (process.env.DATABASE_TEST_URL) {
      pgUrl = process.env.DATABASE_TEST_URL;
    } else {
      // 2. 自动启动 embedded-postgres
      try {
        rmSync(EMBEDDED_DIR, { recursive: true, force: true });
        embedded = new EmbeddedPostgres({
          databaseDir: EMBEDDED_DIR,
          user: 'test',
          password: 'test',
          port: EMBEDDED_PORT,
          persistent: false,
          initdbFlags: ['--locale=C', '--encoding=UTF8'],
          onLog: () => {},
          onError: () => {},
        });
        await embedded.initialise();
        await embedded.start();
        await embedded.createDatabase('jobagent_test');
        pgUrl = `postgres://test:test@localhost:${EMBEDDED_PORT}/jobagent_test`;
      } catch (err) {
        unavailable = (err as Error).message;
        console.warn('[postgres-behavior] embedded-postgres unavailable, tests skip:', unavailable);
        return;
      }
    }

    try {
      storage = await createStorage({
        driver: 'postgres',
        databaseUrl: pgUrl,
        autoMigrate: true,
      });
    } catch (err) {
      unavailable = (err as Error).message;
      console.warn('[postgres-behavior] createStorage failed, tests skip:', unavailable);
    }
  }, 60000);

  afterAll(async () => {
    await storage?.close();
    if (embedded) {
      try {
        await embedded.stop();
      } catch {
        // best-effort
      }
      rmSync(EMBEDDED_DIR, { recursive: true, force: true });
    }
  });

  pgIt('creates, claims FIFO and succeeds a job', async (s) => {
    const suffix = randomUUID().slice(0, 8);
    const oldId = `job_old_${suffix}`;
    const newId = `job_new_${suffix}`;
    await s.jobs.create({ id: oldId, subjectLogin: `u_${suffix}` });
    await s.jobs.create({ id: newId, subjectLogin: `u_${suffix}` });

    const first = await s.jobs.claimNext('pg-test-worker');
    expect(first?.id).toBe(oldId);
    expect(first?.status).toBe('running');
    expect(first?.attempts).toBe(1);

    const second = await s.jobs.claimNext('pg-test-worker');
    expect(second?.id).toBe(newId);

    await s.jobs.succeed(oldId, `prof_ok_${suffix}`, { graphqlPoints: 3 }, []);
    const done = await s.jobs.getById(oldId);
    expect(done?.status).toBe('succeeded');
    expect(done?.profileId).toBe(`prof_ok_${suffix}`);
    expect(done?.budgetUsed).toEqual({ graphqlPoints: 3 });
  });

  pgIt('inserts and reads back a profile with boolean and JSON round-trip', async (s) => {
    const id = `prof_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
    const snapshot = minimalSnapshot(`pg_${randomUUID().slice(0, 6)}`);
    await s.profiles.insert({
      id,
      analyzerVersion: snapshot.analyzerVersion,
      subjectLogin: snapshot.subject.login,
      subjectClaimed: true,
      dataWindowSince: snapshot.dataWindow.since,
      dataWindowUntil: snapshot.dataWindow.until,
      status: 'complete',
      snapshot,
    });
    const stored = await s.profiles.getById(id);
    expect(stored?.subjectClaimed).toBe(true);
    expect(stored?.status).toBe('complete');
    expect(stored?.analysisLayers).toEqual(['L0', 'L1']);
    expect(stored?.snapshot?.subject.login).toBe(snapshot.subject.login);
  });

  pgIt('batch-inserts evidence and counts by profile', async (s) => {
    const profileId = `prof_ev_${randomUUID().slice(0, 8)}`;
    await s.evidence.insertBatch([
      { id: `ev_${randomUUID()}`, profileId, sourceType: 'commit', url: 'https://x/1', layer: 'L1', claim: 'c1', rawRef: 'a' },
      { id: `ev_${randomUUID()}`, profileId, sourceType: 'pr', url: 'https://x/2', layer: 'L1', claim: 'c2', rawRef: 'b' },
    ]);
    expect(await s.evidence.countByProfile(profileId)).toBe(2);
    expect((await s.evidence.listByProfile(profileId))).toHaveLength(2);
  });

  pgIt('rejects duplicate waitlist email', async (s) => {
    const email = `pg_${randomUUID().slice(0, 8)}@example.com`;
    await s.waitlist.insert({ id: `wl_${randomUUID()}`, email });
    await expect(
      s.waitlist.insert({ id: `wl_${randomUUID()}`, email }),
    ).rejects.toThrow();
  });

  pgIt('upserts job postings idempotently and searches case-insensitively', async (s) => {
    const suffix = randomUUID().slice(0, 8);
    const base = {
      jobId: `gh_${suffix}`,
      source: 'greenhouse' as const,
      sourceUrl: `https://example.com/${suffix}/1`,
      title: 'Senior Backend Engineer',
      company: `PG Co ${suffix}`,
      location: 'Remote',
      remote: true,
      salaryMin: null,
      salaryMax: null,
      salaryCurrency: null,
      tags: ['go', 'backend'],
      description: 'd',
      postedAt: '2026-09-01T00:00:00.000Z',
      fetchedAt: '2026-09-10T00:00:00.000Z',
      normalizedKey: `nk_${suffix}`,
    };

    const first = await s.jobPostings.upsertBatch([base], '2026-09-10T00:00:00.000Z');
    expect(first.inserted).toBe(1);
    // second identical run -> unchanged, no duplicate
    const second = await s.jobPostings.upsertBatch([base], '2026-09-11T00:00:00.000Z');
    expect(second.unchanged).toBe(1);

    // ILIKE: lowercase keyword matches capitalized title
    const hits = await s.jobPostings.search({ keyword: 'backend engineer', sources: ['greenhouse'] });
    expect(hits.some((p) => p.sourceUrl === base.sourceUrl)).toBe(true);
  });
});
