import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, type TestContext } from 'vitest';
import type { AbilityProfile } from '@jobagent/shared';
import EmbeddedPostgres from 'embedded-postgres';
import { createStorage } from './storage.js';
import type { StorageContext } from './types.js';
import { openPostgres } from './postgres/connection.js';
import { listMigrationFiles } from './migrations-fs.js';

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
/** postgres 迁移目录：首迁移用例据此推导应应用的迁移条数，不写死数字 */
const POSTGRES_MIGRATIONS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../db/migrations/postgres',
);
const EMBEDDED_PORT = 5433;
// initdb cold start (initialise()) can take tens of seconds and varies with
// disk/CPU load, especially when `pnpm -r test` runs packages concurrently.
// Give it headroom so a slow boot is not mistaken for a hung hook. CI sets
// DATABASE_TEST_URL (docker postgres service) and never boots embedded PG, so
// this timeout only affects local runs.
const EMBEDDED_BOOT_TIMEOUT_MS = 120_000;
// Teardown must stay bounded: when embedded-postgres' start() fails after the
// postgres process already exited, its stop() waits forever for an 'exit' event
// that never fires (start() also rejects with `undefined` on that path).
const TEARDOWN_TIMEOUT_MS = 10_000;

function describeError(err: unknown): string {
  // embedded-postgres rejects start() with `undefined` on early process close
  // (e.g. macOS postmaster "became multithreaded during startup" FATAL); reading
  // .message blindly throws a TypeError that hides the real cause.
  return err instanceof Error ? err.message : String(err);
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${label} timed out after ${ms}ms`)),
        ms,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

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

const T_NOW = '2026-09-22T00:00:00.000Z';

describe('postgres repositories (embedded or DATABASE_TEST_URL)', () => {
  let storage: StorageContext | undefined;
  let embedded: EmbeddedPostgres | null = null;
  // embedded 集群是否真正启动成功；start() 失败后不得再调 stop()（会永久挂起）
  let embeddedRunning = false;
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
        const bootStartedAt = Date.now();
        const elapsedMs = (): number => Date.now() - bootStartedAt;
        embedded = new EmbeddedPostgres({
          databaseDir: EMBEDDED_DIR,
          user: 'test',
          password: 'test',
          port: EMBEDDED_PORT,
          persistent: false,
          initdbFlags: ['--locale=C', '--encoding=UTF8'],
          // onLog is too noisy to keep; onError must stay visible so a stalled
          // boot is not a silent, undiagnosable hang.
          onLog: () => {},
          onError: (messageOrError) =>
            console.warn('[postgres-behavior] embedded postgres error:', messageOrError),
        });
        await embedded.initialise();
        console.warn(`[postgres-behavior] initialise() done in ${elapsedMs()}ms`);
        await embedded.start();
        console.warn(`[postgres-behavior] start() done in ${elapsedMs()}ms`);
        await embedded.createDatabase('jobagent_test');
        console.warn(`[postgres-behavior] createDatabase() done in ${elapsedMs()}ms`);
        embeddedRunning = true;
        pgUrl = `postgres://test:test@localhost:${EMBEDDED_PORT}/jobagent_test`;
      } catch (err) {
        unavailable = describeError(err);
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
      unavailable = describeError(err);
      console.warn('[postgres-behavior] createStorage failed, tests skip:', unavailable);
    }
  }, EMBEDDED_BOOT_TIMEOUT_MS);

  afterAll(async () => {
    if (storage) {
      try {
        await withTimeout(storage.close(), TEARDOWN_TIMEOUT_MS, 'storage.close()');
      } catch (err) {
        console.warn('[postgres-behavior] storage close failed:', describeError(err));
      }
    }
    if (embedded) {
      // start() 失败后 postgres 进程已退出，stop() 会永久等待 exit 事件；
      // 只有确认启动成功才 stop，且整体限时兜底。
      if (embeddedRunning) {
        try {
          await withTimeout(embedded.stop(), TEARDOWN_TIMEOUT_MS, 'embedded.stop()');
        } catch (err) {
          console.warn('[postgres-behavior] embedded stop failed:', describeError(err));
        }
      }
      rmSync(EMBEDDED_DIR, { recursive: true, force: true });
    }
  }, TEARDOWN_TIMEOUT_MS * 3);

  pgIt('ping() resolves on a live Postgres connection (deep health check)', async (s) => {
    await expect(s.ping()).resolves.toBeUndefined();
  });

  // 行级归属在**真实 PG** 上跑一遍：sqlite 侧的同名用例不能替 Postgres 实现背书
  // （两方言是各自一份 repo 代码，#17-F11 的 ownerAccountId 分支必须逐方言验证）。
  pgIt('enforces application row ownership against real Postgres', async (s) => {
    const appliedAt = '2026-09-25T00:00:00.000Z';
    await s.applications.insert({
      id: `app-${randomUUID()}`,
      profileId: 'prof-pg-owner',
      targetTitle: 'Engineer',
      targetCompany: 'Acme',
      appliedAt,
      createdByAccountId: 'acc-owner',
    });
    await s.applications.insert({
      id: `app-${randomUUID()}`,
      profileId: 'prof-pg-owner',
      targetTitle: 'Engineer',
      targetCompany: 'Beta',
      appliedAt,
    });

    const rows = await s.applications.listByProfile('prof-pg-owner');
    expect(rows).toHaveLength(2);
    const owned = rows.find((r) => r.createdByAccountId === 'acc-owner');
    const unowned = rows.find((r) => r.createdByAccountId === null);
    expect(owned).toBeDefined();
    expect(unowned).toBeDefined();

    // 非主改不动，且行内容不变
    expect(await s.applications.update(owned!.id, { status: 'offer' }, 'acc-intruder')).toBeUndefined();
    expect((await s.applications.getById(owned!.id))!.status).toBe('applied');
    // 匿名也改不动有主行
    expect(await s.applications.update(owned!.id, { status: 'offer' }, null)).toBeUndefined();
    // 主改得动；无主行沿用现状
    expect((await s.applications.update(owned!.id, { status: 'interview' }, 'acc-owner'))!.status).toBe(
      'interview',
    );
    expect((await s.applications.update(unowned!.id, { status: 'viewed' }, 'acc-intruder'))!.status).toBe(
      'viewed',
    );
  });

  // 真实竞态：多个并发请求同时走条件 UPDATE ... RETURNING 扣减配额，
  // 行锁必须串行化更新——放行数恰好等于配额，绝不超发。
  pgIt('never over-issues analyze slots under concurrent requests', async (s) => {
    const sessionId = `demo_${randomUUID().replace(/-/g, '')}`;
    await s.demoSessions.create({
      id: sessionId,
      expiresAt: '2026-09-30T00:00:00.000Z',
      ipHash: null,
    });
    const quota = 3;

    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        s.demoSessions.acquireAnalyzeSlot(sessionId, quota, T_NOW),
      ),
    );
    expect(results.filter((r) => r.granted)).toHaveLength(3);
    expect(results.filter((r) => !r.granted)).toHaveLength(7);
    expect((await s.demoSessions.getActive(sessionId, T_NOW))!.analyzeCount).toBe(3);
  });

  pgIt('never partially deducts weighted slots under concurrent fused requests', async (s) => {
    const sessionId = `demo_${randomUUID().replace(/-/g, '')}`;
    await s.demoSessions.create({
      id: sessionId,
      expiresAt: '2026-09-30T00:00:00.000Z',
      ipHash: null,
    });

    const results = await Promise.all(
      Array.from({ length: 3 }, () =>
        s.demoSessions.acquireAnalyzeSlot(sessionId, 3, T_NOW, 2),
      ),
    );
    expect(results.filter((r) => r.granted)).toHaveLength(1);
    for (const d of results.filter((r) => !r.granted)) {
      if (!d.granted) {
        expect(d.reason).toBe('quota_exceeded');
        expect(d.used).toBe(2);
      }
    }
    expect((await s.demoSessions.getActive(sessionId, T_NOW))!.analyzeCount).toBe(2);
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

  // 回归（生产 cron 500，PG 42883 "operator does not exist: text < timestamp with time zone"）：
  // 所有时间戳列都是 text、比较参数是 ISO 字符串。经事务池化（Supabase pooler, prepare=false）
  // 时未显式定型的参数可能被推断成 timestamptz，导致 text < timestamptz 无操作符而整单失败。
  // 钉死：reclaim 用 ::text 定型后，在真 PG 的直连与 pooler(prepare=false) 两种形态下都
  // 正确回收过期 running 任务、保留新近 running 任务，且不抛 42883。
  pgIt('reclaims stale running jobs over text timestamps without 42883', async (s) => {
    if (!basePgUrl) throw new Error('PG url not initialized');
    const suffix = randomUUID().slice(0, 8);
    const staleId = `job_stale_${suffix}`;
    const freshId = `job_fresh_${suffix}`;
    await s.jobs.create({ id: staleId, subjectLogin: `u_${suffix}` });
    await s.jobs.create({ id: freshId, subjectLogin: `u_${suffix}` });

    const tenMinAgo = new Date(Date.now() - 10 * 60_000).toISOString();
    const nowIso = new Date().toISOString();
    const backdate = openPostgres(basePgUrl, { max: 2 });
    try {
      // 直接置 running 并给定 started_at，绕过 claimNext 的 FIFO/队列不确定性
      await backdate.client.unsafe(
        `update analysis_jobs set status='running', attempts=1, claimed_by='w', started_at=$1 where id=$2`,
        [tenMinAgo, staleId],
      );
      await backdate.client.unsafe(
        `update analysis_jobs set status='running', attempts=1, claimed_by='w', started_at=$1 where id=$2`,
        [nowIso, freshId],
      );
    } finally {
      await backdate.client.end({ timeout: 5 });
    }

    const reclaimed = await s.jobs.reclaimStaleRunning(5 * 60_000);
    expect(reclaimed).toBeGreaterThanOrEqual(1);
    expect((await s.jobs.getById(staleId))?.status).toBe('queued');
    expect((await s.jobs.getById(freshId))?.status).toBe('running');

    // pooler 形态（prepare=false，Supabase 6543 同款）：::text 定型的比较必须健康
    const pooled = openPostgres(basePgUrl, { max: 2, prepare: false });
    try {
      const rows = await pooled.client.unsafe(
        `select id from analysis_jobs where status='running' and started_at < $1::text limit 5`,
        [new Date(Date.now() - 5 * 60_000).toISOString()],
      );
      expect(Array.isArray(rows)).toBe(true);
    } finally {
      await pooled.client.end({ timeout: 5 });
    }
  });

  // 阶段 1「求职工作台」：状态机并发闸 + 人机闸票据 + 每源每日限频都在真 PG 上各跑一遍
  // （SQLite 侧的同名用例不能替 Postgres 实现背书：两方言是各自一份 repo 代码）。
  pgIt('guards job_run transitions with a conditional update', async (s) => {
    const suffix = randomUUID().slice(0, 8);
    const runId = `run_pg_${suffix}`;
    await s.jobRuns.insert({
      id: runId,
      accountId: `acc_${suffix}`,
      profileId: `prof_${suffix}`,
      preferenceId: `pref_${suffix}`,
      createdAt: T_NOW,
    });
    expect((await s.jobRuns.getById(runId))?.status).toBe('created');

    // 并发的两个推进者（cron + 用户手动触发）只有一个能拿到这行
    const [a, b] = await Promise.all([
      s.jobRuns.compareAndSetStatus(runId, 'created', { status: 'configured', updatedAt: T_NOW }),
      s.jobRuns.compareAndSetStatus(runId, 'created', { status: 'failed', updatedAt: T_NOW }),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect(['configured', 'failed']).toContain((await s.jobRuns.getById(runId))!.status);
    // 拿到行的那一方之后，陈旧期望再也推不动
    expect(
      await s.jobRuns.compareAndSetStatus(runId, 'created', {
        status: 'watching',
        updatedAt: T_NOW,
      }),
    ).toBeUndefined();

    // 队列排序：从未扫描（last_scan_at 为 NULL）的任务必须排在已扫描过的前面。
    // 上面那条 runId 已被推进到 configured/failed，不再属于本查询的状态集合，故另建两条。
    const neverScannedId = `run_pg_never_${suffix}`;
    await s.jobRuns.insert({
      id: neverScannedId,
      accountId: `acc_${suffix}`,
      profileId: `prof_${suffix}`,
      preferenceId: `pref_${suffix}`,
      createdAt: T_NOW,
    });
    // 新任务一律从 created 起步，推进到 watching 时**不写 lastScanAt**（即"从未扫描"）
    await s.jobRuns.compareAndSetStatus(neverScannedId, 'created', {
      status: 'watching',
      updatedAt: T_NOW,
    });
    await s.jobRuns.insert({
      id: `run_pg2_${suffix}`,
      accountId: `acc_${suffix}`,
      profileId: `prof_${suffix}`,
      preferenceId: `pref_${suffix}`,
      createdAt: T_NOW,
    });
    await s.jobRuns.compareAndSetStatus(`run_pg2_${suffix}`, 'created', {
      status: 'watching',
      lastScanAt: T_NOW, // 已扫描过：必须排在"从未扫描"（NULL）之后
      updatedAt: T_NOW,
    });
    const queue = await s.jobRuns.listByStatuses(['created', 'watching'], 200);
    const idxNeverScanned = queue.findIndex((r) => r.id === neverScannedId);
    const idxScanned = queue.findIndex((r) => r.id === `run_pg2_${suffix}`);
    expect(idxNeverScanned).toBeGreaterThanOrEqual(0);
    expect(idxScanned).toBeGreaterThanOrEqual(0);
    expect(idxNeverScanned).toBeLessThan(idxScanned);
  });

  pgIt('gates submit tickets behind the human approval workflow', async (s) => {
    const suffix = randomUUID().slice(0, 8);
    const accountId = `acc_si_${suffix}`;
    const runId = `run_si_${suffix}`;
    const job = {
      jobId: `job_${suffix}`,
      source: 'greenhouse' as const,
      sourceUrl: `https://example.com/${suffix}/job`,
      title: 'Staff Engineer',
      company: `PG Co ${suffix}`,
      location: 'Remote',
      remote: true,
      salaryMin: null,
      salaryMax: null,
      salaryCurrency: null,
      tags: ['go'],
      postedAt: T_NOW,
    };
    const report = {
      ruleVersion: '0.1',
      score: 6,
      tier: 'high' as const,
      fieldScores: { title: 3, tags: 2, description: 1 },
      matchedSkills: ['go'],
      reasons: [{ code: 'title_match' as const, skill: 'go', points: 3 }],
      gaps: [],
      suggestedBoost: [],
    };
    const ticket = (id: string, createdAt: string) => ({
      id,
      runId,
      accountId,
      profileId: `prof_${suffix}`,
      jobId: job.jobId,
      jobSource: job.source,
      job,
      matchScore: 6,
      matchTier: 'high' as const,
      report,
      createdAt,
      updatedAt: createdAt,
    });

    const pendingId = `intent_pending_${suffix}`;
    const rejectedId = `intent_rejected_${suffix}`;
    await s.submitIntents.insertMany([ticket(pendingId, T_NOW), ticket(rejectedId, T_NOW)]);

    const stored = await s.submitIntents.getById(pendingId);
    expect(stored?.status).toBe('pending');
    expect(stored?.job).toEqual(job);
    expect(stored?.report).toEqual(report);

    // 拒绝一张票后它不再可被 approveMany 移动
    expect((await s.submitIntents.reject(rejectedId, 'nope', T_NOW))?.status).toBe('rejected');
    expect(await s.submitIntents.approveMany(runId, [pendingId, rejectedId], T_NOW)).toBe(1);
    expect(await s.submitIntents.approveMany(runId, [pendingId], T_NOW)).toBe(0);
    expect((await s.submitIntents.getById(pendingId))?.approvedAt).toBe(T_NOW);

    // 已投出：approved → submitted，并回填 applications.id
    const submitted = await s.submitIntents.markSubmitted(pendingId, T_NOW, `app_${suffix}`);
    expect(submitted?.status).toBe('submitted');
    expect(submitted?.applicationId).toBe(`app_${suffix}`);
    expect(await s.submitIntents.markSubmitted(rejectedId, T_NOW, null)).toBeUndefined();

    // 每源每日限频：只数 approved/submitted，且窗口与账号、来源都要对上
    // （时间戳比较走 ::text 定型，pooler(prepare=false) 下也不会撞 42883）
    expect(await s.submitIntents.countCommittedBySourceSince(accountId, 'greenhouse', T_NOW)).toBe(1);
    expect(await s.submitIntents.countCommittedBySourceSince(accountId, 'lever', T_NOW)).toBe(0);
    expect(
      await s.submitIntents.countCommittedBySourceSince(accountId, 'greenhouse', '2026-09-23T00:00:00.000Z'),
    ).toBe(0);
    expect(
      await s.submitIntents.countCommittedBySourceSince(`acc_other_${suffix}`, 'greenhouse', T_NOW),
    ).toBe(0);
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
        // 期望条数从迁移目录推导，不写死数字：加一条迁移就会让这里红一次假警报。
        expect(versions).toHaveLength(
          listMigrationFiles(POSTGRES_MIGRATIONS_DIR).length,
        );
        expect(versions.map((v) => v.version)).toEqual(
          listMigrationFiles(POSTGRES_MIGRATIONS_DIR).map((f) => f.slice(0, 3)),
        );
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
          'interviews',
          'accounts',
          'auth_sessions',
          'job_preferences',
          'job_runs',
          'job_run_events',
          'submit_intents',
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
