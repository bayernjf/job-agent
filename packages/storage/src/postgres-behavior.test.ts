import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, type TestContext } from 'vitest';
import type { AbilityProfile } from '@jobagent/shared';
import EmbeddedPostgres from 'embedded-postgres';
import { createStorage } from './storage.js';
import type { StorageContext } from './types.js';
import { openPostgres } from './postgres/connection.js';

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
  // 已迁移测试库的连接串；adminUrl 指向维护库（postgres），用于创建/删除临时库
  let basePgUrl: string | undefined;
  let adminUrl: string | undefined;
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
      basePgUrl = pgUrl;
      // 维护库连接串（把末尾业务库名替换为 postgres），用于 CREATE/DROP DATABASE
      adminUrl = pgUrl.replace(/\/[^/]+$/, '/postgres');
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

  pgIt('defers an over-cap demo job back to queued without burning attempts', async (s) => {
    const id = `job_defer_${randomUUID().slice(0, 8)}`;
    await s.jobs.create({
      id,
      subjectLogin: `d_${id}`,
      requesterKind: 'demo',
      demoSessionId: 's1',
    });
    const claimed = await s.jobs.claimNext('pg-test-worker');
    expect(claimed?.id).toBe(id);
    expect(claimed?.attempts).toBe(1);

    await s.jobs.deferToQueued(id, 'Deferred: demo concurrency cap');
    const back = await s.jobs.getById(id);
    expect(back?.status).toBe('queued');
    expect(back?.attempts).toBe(0);
    expect(back?.claimedBy).toBeNull();
    expect(back?.errorMessage).toBeNull();

    // GREATEST 下限：再次认领→退回仍稳定在 0，不被 attempts<3 永久排除
    const reclaimed = await s.jobs.claimNext('pg-test-worker');
    expect(reclaimed?.id).toBe(id);
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

  // 回归：api + worker（或水平扩容的多个副本）同时冷启动、对同一空库并发首迁移时，
  // 不得因 schema_migrations 主键冲突而崩溃；迁移应恰好应用一次。
  pgIt('runs concurrent first-time migrations safely across instances', async () => {
    if (!basePgUrl || !adminUrl) throw new Error('PG urls not initialized');
    // 仅含十六进制字符，作为标识符插值安全（CREATE/DROP DATABASE 不支持参数绑定）
    const dbName = `ja_concur_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const targetUrl = basePgUrl.replace(/\/[^/]+$/, `/${dbName}`);
    const admin = openPostgres(adminUrl);
    try {
      await admin.client.unsafe(`CREATE DATABASE ${dbName}`);

      // 两个独立实例（各自连接池）对同一空库并发首迁移，修复前会 duplicate key 崩溃。
      const storages = await Promise.all([
        createStorage({ driver: 'postgres', databaseUrl: targetUrl, autoMigrate: true }),
        createStorage({ driver: 'postgres', databaseUrl: targetUrl, autoMigrate: true }),
      ]);

      // 第三个连接核对：迁移恰好应用一次、业务表齐全。
      const verify = openPostgres(targetUrl);
      try {
        const versions =
          await verify.client<Array<{ version: string }>>`SELECT version FROM schema_migrations ORDER BY version`;
        expect(versions).toHaveLength(11);
        const rows =
          await verify.client<Array<{ table_name: string }>>`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`;
        const names = rows.map((r) => r.table_name);
        for (const table of [
          'profiles',
          'analysis_jobs',
          'evidence',
          'waitlist',
          'job_postings',
          'demo_sessions',
          'demo_rate_events',
          'applications',
          'accounts',
          'auth_sessions',
        ]) {
          expect(names).toContain(table);
        }
      } finally {
        await verify.client.end({ timeout: 5 });
      }
      for (const c of storages) await c.close();
    } finally {
      // 踢掉残留连接后删除临时库。
      try {
        await admin.client.unsafe(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${dbName}' AND pid <> pg_backend_pid()`,
        );
        await admin.client.unsafe(`DROP DATABASE IF EXISTS ${dbName}`);
      } finally {
        await admin.client.end({ timeout: 5 });
      }
    }
  });
});
