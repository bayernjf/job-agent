import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, type TestContext } from 'vitest';
import type { AbilityProfile, FunnelEventName } from '@jobagent/shared';
import EmbeddedPostgres from 'embedded-postgres';
import { createStorage } from './storage.js';
import type { StorageContext } from './types.js';
import type { NewApplication, NewJobRunEvent, NewSubmitIntent } from './entities/index.js';
import type { FunnelEventRecord } from './entities/funnel-event.js';
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
// 求职 Agent 事务用例的相对时刻：T_NOW 同时作限频窗口起点（since）
const T_P1 = '2026-09-22T01:00:00.000Z';
const T_P2 = '2026-09-22T02:00:00.000Z';
const T_P3 = '2026-09-22T03:00:00.000Z';

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

  // 事件流的窗口语义在**真实 PG** 上钉一次：两方言各有一份 repo 代码，
  // "跑满上限后界面冻住"是取回侧（asc + limit 给最旧 N 条）的错，sqlite 用例不能替 Postgres 背书。
  pgIt('returns the newest events in replay order when the stream exceeds the limit', async (s) => {
    const runId = `run-${randomUUID()}`;
    const base = Date.parse('2026-10-10T00:00:00.000Z');
    for (let i = 0; i < 12; i += 1) {
      await s.jobRunEvents.insert({
        id: `evt-${randomUUID()}`,
        runId,
        event: 'rescan',
        fromStatus: 'watching',
        toStatus: 'watching',
        actor: 'agent',
        createdAt: new Date(base + i * 60_000).toISOString(),
      });
    }

    const page = await s.jobRunEvents.listLatestPage(runId, 5);
    expect(page.events).toHaveLength(5);
    expect(page.hasMore).toBe(true);
    // 截掉的是最旧 7 条，最新 5 条必须都在，且返回顺序仍是正序（回放顺序）
    expect(page.events.map((e) => e.createdAt)).toEqual(
      [7, 8, 9, 10, 11].map((i) => new Date(base + i * 60_000).toISOString()),
    );

    // 往前翻：游标是**事件 id**，不是时间戳（时间戳游标会把同刻那组从中间切断）
    const older = await s.jobRunEvents.listOlderPage(runId, page.events[0]!.id, 5);
    expect(older!.events.map((e) => e.createdAt)).toEqual(
      [2, 3, 4, 5, 6].map((i) => new Date(base + i * 60_000).toISOString()),
    );
    expect(older!.hasMore).toBe(true);
    expect(await s.jobRunEvents.listOlderPage(runId, 'evt-nope', 5)).toBeUndefined();

    // 同一时刻多条迁移（一次 tick 推进一步以上）靠 ctid 保回放顺序：主键是 evt-<uuid>，
    // 拿它当次级排序键会把 validate/start/candidates_ready/generated 排成乱序。
    const tiedRunId = `run-${randomUUID()}`;
    const tiedAt = '2026-10-10T06:00:00.000Z';
    // 套件里有用固定主键的先例会在同一库连跑两遍时假红，这里按 run 加随机后缀；
    // z/m/a 前缀保持"id 字典序与写入顺序相反"这一针对性
    const tag = randomUUID().slice(0, 8);
    const tiedIds = [`zz-${tag}`, `mm-${tag}`, `aa-${tag}`];
    for (const id of tiedIds) {
      await s.jobRunEvents.insert({
        id,
        runId: tiedRunId,
        event: 'rescan',
        fromStatus: 'watching',
        toStatus: 'watching',
        actor: 'agent',
        createdAt: tiedAt,
      });
    }
    expect((await s.jobRunEvents.listLatestPage(tiedRunId)).events.map((e) => e.id)).toEqual(
      tiedIds,
    );
    expect((await s.jobRunEvents.listLatestPage(tiedRunId, 2)).events.map((e) => e.id)).toEqual([
      tiedIds[1],
      tiedIds[2],
    ]);
    // 同刻组按 ctid 逐个跳过：翻到第二条之前只剩最早那条，不多不少
    const tiedOlder = await s.jobRunEvents.listOlderPage(tiedRunId, tiedIds[1]!, 2);
    expect(tiedOlder!.events.map((e) => e.id)).toEqual([tiedIds[0]]);
    expect(tiedOlder!.hasMore).toBe(false);
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

  // CAS 状态迁移与审计事件必须在**同一事务**落库：赢家有事件，输家（陈旧期望）与
  // 未知 id 零事件。两方言各一份 repo 代码，真 PG 上再钉一次（镜像 sqlite job-runs 用例）。
  pgIt('commits the CAS and its audit event atomically', async (s) => {
    const suffix = randomUUID().slice(0, 8);
    const runId = `run_evt_${suffix}`;
    const accountId = `acc_evt_${suffix}`;
    const profileId = `prof_evt_${suffix}`;
    const preferenceId = `pref_evt_${suffix}`;
    await s.jobRuns.insert({ id: runId, accountId, profileId, preferenceId, createdAt: T_NOW });

    const winner = await s.jobRuns.compareAndSetStatusWithEvent(
      runId,
      'created',
      { status: 'watching', updatedAt: T_P1 },
      {
        id: `evt_${randomUUID()}`,
        runId,
        event: 'start',
        fromStatus: 'created',
        toStatus: 'watching',
        actor: 'system',
        createdAt: T_P1,
      },
    );
    expect(winner?.status).toBe('watching');
    const page = await s.jobRunEvents.listLatestPage(runId);
    expect(page.hasMore).toBe(false);
    expect(page.events).toHaveLength(1);
    expect(page.events[0]!).toMatchObject({
      runId,
      event: 'start',
      fromStatus: 'created',
      toStatus: 'watching',
      actor: 'system',
    });

    // 输家（陈旧期望）拿不到行，也不得留下审计事件
    const stale = await s.jobRuns.compareAndSetStatusWithEvent(
      runId,
      'created',
      { status: 'recommending', updatedAt: T_P2 },
      {
        id: `evt_${randomUUID()}`,
        runId,
        event: 'candidates_ready',
        fromStatus: 'created',
        toStatus: 'recommending',
        actor: 'system',
        createdAt: T_P2,
      },
    );
    expect(stale).toBeUndefined();
    expect((await s.jobRunEvents.listLatestPage(runId)).events).toHaveLength(1);

    // 未知 id 同样零事件
    const missingRunId = `run_evt_missing_${suffix}`;
    expect(
      await s.jobRuns.compareAndSetStatusWithEvent(
        missingRunId,
        'created',
        { status: 'watching', updatedAt: T_P2 },
        {
          id: `evt_${randomUUID()}`,
          runId: missingRunId,
          event: 'start',
          fromStatus: 'created',
          toStatus: 'watching',
          actor: 'system',
          createdAt: T_P2,
        },
      ),
    ).toBeUndefined();
    expect((await s.jobRunEvents.listLatestPage(missingRunId)).events).toHaveLength(0);
  });

  // generated 发布是 run + 票据 + 事件的三表事务：赢家三表齐落，输家零票据零事件不留孤儿。
  pgIt('publishes run, tickets and the generated event in one transaction', async (s) => {
    const suffix = randomUUID().slice(0, 8);
    const accountId = `acc_pub_${suffix}`;
    const profileId = `prof_pub_${suffix}`;
    const preferenceId = `pref_pub_${suffix}`;
    const run1 = `run_pub1_${suffix}`;
    const run2 = `run_pub2_${suffix}`;
    await s.jobRuns.insert({ id: run1, accountId, profileId, preferenceId, createdAt: T_NOW });
    await s.jobRuns.insert({ id: run2, accountId, profileId, preferenceId, createdAt: T_NOW });
    // run1 已到 recommending；run2 还停在 watching（持陈旧期望的那一方）
    await s.jobRuns.compareAndSetStatus(run1, 'created', { status: 'recommending', updatedAt: T_P1 });
    await s.jobRuns.compareAndSetStatus(run2, 'created', { status: 'watching', updatedAt: T_P1 });

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
    const ticket = (id: string, runId: string): NewSubmitIntent => ({
      id,
      runId,
      accountId,
      profileId,
      jobId: `job_${id}`,
      jobSource: 'remoteok' as const,
      job: {
        jobId: `job_${id}`,
        source: 'remoteok' as const,
        sourceUrl: `https://example.com/${id}/job`,
        title: 'Senior Backend Engineer',
        company: `PG Co ${suffix}`,
        location: 'Remote',
        remote: true,
        salaryMin: null,
        salaryMax: null,
        salaryCurrency: null,
        tags: ['go'],
        postedAt: T_NOW,
      },
      matchScore: 6,
      matchTier: 'high' as const,
      report,
      createdAt: T_P2,
      updatedAt: T_P2,
    });
    const generatedEvent = (id: string, runId: string): NewJobRunEvent => ({
      id,
      runId,
      event: 'generated' as const,
      fromStatus: 'recommending',
      toStatus: 'awaiting_approval',
      actor: 'agent' as const,
      createdAt: T_P2,
      payload: { candidates: 2 },
    });

    const intentA = `intent_pub_a_${suffix}`;
    const intentB = `intent_pub_b_${suffix}`;
    const winner = await s.jobRuns.publishGeneratedIntents(
      run1,
      'recommending',
      { status: 'awaiting_approval', updatedAt: T_P2 },
      generatedEvent(`evt_${randomUUID()}`, run1),
      [ticket(intentA, run1), ticket(intentB, run1)],
    );
    expect(winner?.status).toBe('awaiting_approval');
    const tickets = await s.submitIntents.listByRun(run1);
    expect(tickets.map((x) => x.id).sort()).toEqual([intentA, intentB]);
    expect(tickets.every((x) => x.status === 'pending')).toBe(true);
    const page = await s.jobRunEvents.listLatestPage(run1);
    expect(page.events).toHaveLength(1);
    expect(page.events[0]!.event).toBe('generated');
    expect(page.events[0]!.payload).toEqual({ candidates: 2 });

    // 输家：CAS 0 行 → undefined，零票据、零事件
    const loser = await s.jobRuns.publishGeneratedIntents(
      run2,
      'recommending',
      { status: 'awaiting_approval', updatedAt: T_P2 },
      generatedEvent(`evt_${randomUUID()}`, run2),
      [ticket(`intent_pub_c_${suffix}`, run2)],
    );
    expect(loser).toBeUndefined();
    expect((await s.jobRuns.getById(run2))!.status).toBe('watching');
    expect(await s.submitIntents.listByRun(run2)).toHaveLength(0);
    expect((await s.jobRunEvents.listLatestPage(run2)).events).toHaveLength(0);
  });

  // markSubmittedWithApplication：票据 CAS 与 application 行同事务；重复幂等不重插；
  // 035 之前的孤儿 application 被补齐回链而不是再插一条；rejected/未知票据一律 invalid。
  pgIt('marks submitted with an application row atomically and reconciles orphans', async (s) => {
    const suffix = randomUUID().slice(0, 8);
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
    const ticket = (
      id: string,
      runId: string,
      accountId: string,
      profileId: string,
      extra: Partial<NewSubmitIntent> = {},
    ): NewSubmitIntent => ({
      id,
      runId,
      accountId,
      profileId,
      jobId: `job_${id}`,
      jobSource: 'remoteok' as const,
      job: {
        jobId: `job_${id}`,
        source: 'remoteok' as const,
        sourceUrl: `https://example.com/${id}/job`,
        applyUrl: `https://example.com/${id}/apply`,
        title: 'Senior Backend Engineer',
        company: `PG Co ${suffix}`,
        location: 'Remote',
        remote: true,
        salaryMin: null,
        salaryMax: null,
        salaryCurrency: null,
        tags: ['go'],
        postedAt: T_NOW,
      },
      matchScore: 6,
      matchTier: 'high' as const,
      report,
      createdAt: T_P1,
      updatedAt: T_P1,
      ...extra,
    });
    const application = (
      id: string,
      profileId: string,
      intentId: string,
      accountId: string,
    ): NewApplication => ({
      id,
      profileId,
      jobId: `job_${intentId}`,
      source: 'remoteok' as const,
      targetTitle: 'Senior Backend Engineer',
      targetCompany: `PG Co ${suffix}`,
      targetUrl: `https://example.com/${intentId}/apply`,
      origin: 'agent' as const,
      appliedAt: T_P3,
      createdByAccountId: accountId,
      submitIntentId: intentId,
    });

    // 场景 A：pending → submitted，票据与 application 同事务；重复调用幂等不重插
    const aSuffix = `mwa_${suffix}`;
    const intentA = `intent_${aSuffix}`;
    await s.submitIntents.insertMany([ticket(intentA, `run_${aSuffix}`, `acc_${aSuffix}`, `prof_${aSuffix}`)]);
    const appA = `app_${randomUUID()}`;
    const result = await s.submitIntents.markSubmittedWithApplication(
      intentA,
      application(appA, `prof_${aSuffix}`, intentA, `acc_${aSuffix}`),
      T_P3,
    );
    expect(result.outcome).toBe('submitted');
    if (result.outcome !== 'submitted') throw new Error('expected submitted outcome');
    expect(result.intent.status).toBe('submitted');
    expect(result.intent.submittedAt).toBe(T_P3);
    expect(result.intent.applicationId).toBe(appA);
    expect(result.application.submitIntentId).toBe(intentA);
    expect(result.application.origin).toBe('agent');
    expect(await s.applications.listByProfile(`prof_${aSuffix}`)).toHaveLength(1);

    const again = await s.submitIntents.markSubmittedWithApplication(
      intentA,
      application(`app_${randomUUID()}`, `prof_${aSuffix}`, intentA, `acc_${aSuffix}`),
      T_P3,
    );
    expect(again.outcome).toBe('already');
    if (again.outcome !== 'already') throw new Error('expected already outcome');
    expect(again.intent.status).toBe('submitted');
    expect(again.intent.applicationId).toBe(appA);
    expect(again.application!.id).toBe(appA);
    expect(await s.applications.listByProfile(`prof_${aSuffix}`)).toHaveLength(1);

    // 场景 B：035 之前的孤儿 application（已回链、票据仍 pending）→ 补齐票据，不重插
    const bSuffix = `orp_${suffix}`;
    const intentOrphan = `intent_${bSuffix}`;
    const appOrphan = `app_${randomUUID()}`;
    await s.submitIntents.insertMany([
      ticket(intentOrphan, `run_${bSuffix}`, `acc_${bSuffix}`, `prof_${bSuffix}`),
    ]);
    await s.applications.insert(
      application(appOrphan, `prof_${bSuffix}`, intentOrphan, `acc_${bSuffix}`),
    );
    const reconciled = await s.submitIntents.markSubmittedWithApplication(
      intentOrphan,
      application(`app_${randomUUID()}`, `prof_${bSuffix}`, intentOrphan, `acc_${bSuffix}`),
      T_P3,
    );
    expect(reconciled.outcome).toBe('already');
    if (reconciled.outcome !== 'already') throw new Error('expected already outcome');
    expect(reconciled.intent.status).toBe('submitted');
    expect(reconciled.intent.submittedAt).toBe(T_P3);
    expect(reconciled.application!.id).toBe(appOrphan);
    expect((await s.applications.listByProfile(`prof_${bSuffix}`)).map((r) => r.id)).toEqual([
      appOrphan,
    ]);

    // 场景 C：rejected / 未知票据 → invalid，零 application
    const cSuffix = `inv_${suffix}`;
    const intentRejected = `intent_${cSuffix}`;
    await s.submitIntents.insertMany([
      ticket(intentRejected, `run_${cSuffix}`, `acc_${cSuffix}`, `prof_${cSuffix}`, {
        status: 'rejected',
        rejectedAt: T_P2,
        updatedAt: T_P2,
      }),
    ]);
    const fromRejected = await s.submitIntents.markSubmittedWithApplication(
      intentRejected,
      application(`app_${randomUUID()}`, `prof_${cSuffix}`, intentRejected, `acc_${cSuffix}`),
      T_P3,
    );
    expect(fromRejected.outcome).toBe('invalid');
    expect((await s.submitIntents.getById(intentRejected))!.status).toBe('rejected');
    const fromUnknown = await s.submitIntents.markSubmittedWithApplication(
      `intent_missing_${suffix}`,
      application(`app_${randomUUID()}`, `prof_${cSuffix}`, `intent_missing_${suffix}`, `acc_${cSuffix}`),
      T_P3,
    );
    expect(fromUnknown.outcome).toBe('invalid');
    expect(await s.applications.listByProfile(`prof_${cSuffix}`)).toHaveLength(0);
  });

  // approveManyWithQuota：账号级咨询锁 + 逐源判额；整批通过/空批 no-op；超限整批回滚逐字段报额；
  // 已处理票据不占请求数；逐源独立计额（一个源超限连本可通过的另一个源一起回滚）。
  pgIt('approves a batch atomically per source quota and rolls back over the limit', async (s) => {
    const suffix = randomUUID().slice(0, 8);
    const baseReport = {
      ruleVersion: '0.1',
      score: 6,
      tier: 'high' as const,
      fieldScores: { title: 3, tags: 2, description: 1 },
      matchedSkills: ['go'],
      reasons: [{ code: 'title_match' as const, skill: 'go', points: 3 }],
      gaps: [],
      suggestedBoost: [],
    };
    const ticket = (
      id: string,
      runId: string,
      accountId: string,
      source: 'remoteok' | 'greenhouse',
      createdAt: string,
      extra: Partial<NewSubmitIntent> = {},
    ): NewSubmitIntent => ({
      id,
      runId,
      accountId,
      profileId: `prof_q_${suffix}`,
      jobId: `job_${id}`,
      jobSource: source,
      job: {
        jobId: `job_${id}`,
        source,
        sourceUrl: `https://example.com/${id}/job`,
        title: 'Senior Backend Engineer',
        company: `PG Co ${suffix}`,
        location: 'Remote',
        remote: true,
        salaryMin: null,
        salaryMax: null,
        salaryCurrency: null,
        tags: ['go'],
        postedAt: T_NOW,
      },
      matchScore: 6,
      matchTier: 'high' as const,
      report: baseReport,
      createdAt,
      updatedAt: createdAt,
      ...extra,
    });

    // ① 整批通过 + 空批 no-op
    const okAccount = `acc_qok_${suffix}`;
    const okRun = `run_qok_${suffix}`;
    await s.submitIntents.insertMany([
      ticket(`intent_qok_a_${suffix}`, okRun, okAccount, 'remoteok', T_P1),
      ticket(`intent_qok_b_${suffix}`, okRun, okAccount, 'remoteok', T_P2),
    ]);
    const okIds = [`intent_qok_a_${suffix}`, `intent_qok_b_${suffix}`];
    expect(
      await s.submitIntents.approveManyWithQuota(okRun, okAccount, okIds, 5, T_NOW, T_P3),
    ).toEqual({ outcome: 'approved', approved: 2 });
    for (const id of okIds) {
      const stored = (await s.submitIntents.getById(id))!;
      expect(stored.status).toBe('approved');
      expect(stored.approvedAt).toBe(T_P3);
    }
    expect(
      await s.submitIntents.approveManyWithQuota(okRun, okAccount, [], 5, T_NOW, T_P3),
    ).toEqual({ outcome: 'approved', approved: 0 });

    // ② 窗口内已确认 1 笔 + 本次请求 2 笔 > limit 2：整单回滚，逐字段报额
    const xAccount = `acc_qx_${suffix}`;
    const xRun = `run_qx_${suffix}`;
    await s.submitIntents.insertMany([
      ticket(`intent_qx_done_${suffix}`, xRun, xAccount, 'remoteok', T_P1, {
        status: 'approved',
        approvedAt: T_P1,
      }),
      ticket(`intent_qx_a_${suffix}`, xRun, xAccount, 'remoteok', T_P2),
      ticket(`intent_qx_b_${suffix}`, xRun, xAccount, 'remoteok', T_P3),
    ]);
    const xIds = [`intent_qx_a_${suffix}`, `intent_qx_b_${suffix}`];
    expect(
      await s.submitIntents.approveManyWithQuota(xRun, xAccount, xIds, 2, T_NOW, T_P3),
    ).toEqual({
      outcome: 'quota_exceeded',
      source: 'remoteok',
      committed: 1,
      remaining: 1,
      requested: 2,
    });
    for (const id of xIds) {
      expect((await s.submitIntents.getById(id))!.status).toBe('pending');
    }

    // ③ rejected 票据不在 pending 分组：limit 2 下请求数只有 2，整批通过且 rejected 不复活
    const pAccount = `acc_qp_${suffix}`;
    const pRun = `run_qp_${suffix}`;
    await s.submitIntents.insertMany([
      ticket(`intent_qp_a_${suffix}`, pRun, pAccount, 'remoteok', T_P1),
      ticket(`intent_qp_b_${suffix}`, pRun, pAccount, 'remoteok', T_P2),
      ticket(`intent_qp_r_${suffix}`, pRun, pAccount, 'remoteok', T_P3, {
        status: 'rejected',
        rejectedAt: T_P3,
        updatedAt: T_P3,
      }),
    ]);
    expect(
      await s.submitIntents.approveManyWithQuota(
        pRun,
        pAccount,
        [`intent_qp_a_${suffix}`, `intent_qp_b_${suffix}`, `intent_qp_r_${suffix}`],
        2,
        T_NOW,
        T_P3,
      ),
    ).toEqual({ outcome: 'approved', approved: 2 });
    expect((await s.submitIntents.getById(`intent_qp_r_${suffix}`))!.status).toBe('rejected');

    // ④ 逐源独立计额：greenhouse 已确认 1 笔，本次 gh 1 + remoteok 1，limit 1 下
    //    只有 greenhouse 超限（构造上保证结果唯一，不依赖 GROUP BY 返回顺序）；
    //    本可通过的 remoteok 随整批一起回滚。放大 limit 后同批票据逐源通过。
    const sAccount = `acc_qs_${suffix}`;
    const sRun = `run_qs_${suffix}`;
    await s.submitIntents.insertMany([
      ticket(`intent_qs_done_${suffix}`, sRun, sAccount, 'greenhouse', T_P1, {
        status: 'approved',
        approvedAt: T_P1,
      }),
      ticket(`intent_qs_gh_${suffix}`, sRun, sAccount, 'greenhouse', T_P1),
      ticket(`intent_qs_ro_${suffix}`, sRun, sAccount, 'remoteok', T_P2),
    ]);
    const sIds = [`intent_qs_gh_${suffix}`, `intent_qs_ro_${suffix}`];
    expect(
      await s.submitIntents.approveManyWithQuota(sRun, sAccount, sIds, 1, T_NOW, T_P3),
    ).toEqual({
      outcome: 'quota_exceeded',
      source: 'greenhouse',
      committed: 1,
      remaining: 0,
      requested: 1,
    });
    for (const id of sIds) {
      expect((await s.submitIntents.getById(id))!.status).toBe('pending');
    }
    expect(
      await s.submitIntents.approveManyWithQuota(sRun, sAccount, sIds, 3, T_NOW, T_P3),
    ).toEqual({ outcome: 'approved', approved: 2 });
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

  pgIt('publishes profile, evidence and job success in one transaction', async (s) => {
    const suffix = randomUUID().slice(0, 8);
    const jobId = `job_pub_${suffix}`;
    const profileId = `prof_pub_${suffix}`;
    const snapshot = minimalSnapshot(`pg_${suffix}`);
    // 刻意不走 claimNext：它按全表 FIFO 认领，库里有别的行时会认领到别人的任务
    // （本文件既有 reclaim 用例也是因此改用 raw update 直接置 running）。
    // publishWithEvidenceAndJob 只按 jobId 更新、不校验来源状态，故 queued 起步即可。
    await s.jobs.create({ id: jobId, subjectLogin: snapshot.subject.login });

    await s.profiles.publishWithEvidenceAndJob({
      profile: {
        id: profileId,
        analyzerVersion: snapshot.analyzerVersion,
        subjectLogin: snapshot.subject.login,
        dataWindowSince: snapshot.dataWindow.since,
        dataWindowUntil: snapshot.dataWindow.until,
        status: 'complete',
        snapshot,
      },
      evidence: [
        {
          evidenceId: `ev_${suffix}`,
          sourcePlatform: 'github',
          sourceType: 'commit',
          url: 'https://x/1',
          layer: 'L1',
          claim: 'c',
          rawRef: 'r',
        },
      ],
      jobId,
      budgetUsed: { graphqlPoints: 7 },
      missing: [],
    });

    expect((await s.profiles.getById(profileId))?.status).toBe('complete');
    expect(await s.evidence.countByProfile(profileId)).toBe(1);
    const job = await s.jobs.getById(jobId);
    expect(job?.status).toBe('succeeded');
    expect(job?.stage).toBe('complete');
    expect(job?.profileId).toBe(profileId);
    expect(job?.budgetUsed).toEqual({ graphqlPoints: 7 });
  });

  pgIt('rolls the whole publication back when the evidence write raises 23505', async (s) => {
    const suffix = randomUUID().slice(0, 8);
    const jobId = `job_rb_${suffix}`;
    const profileId = `prof_rb_${suffix}`;
    const snapshot = minimalSnapshot(`pg_${suffix}`);
    await s.jobs.create({ id: jobId, subjectLogin: snapshot.subject.login });
    // Pre-occupy the (profile_id, id) primary key. On Postgres a constraint violation
    // aborts the *whole* transaction (not just the statement), so this is the case where
    // a missing SAVEPOINT would surface as a confusing 25P02 instead of a clean rollback.
    await s.evidence.insertBatch([
      { id: `ev_${suffix}`, profileId, sourceType: 'commit', url: 'https://x/0', layer: 'L1', claim: 'c0', rawRef: 'r0' },
    ]);

    await expect(
      s.profiles.publishWithEvidenceAndJob({
        profile: {
          id: profileId,
          analyzerVersion: snapshot.analyzerVersion,
          subjectLogin: snapshot.subject.login,
          dataWindowSince: snapshot.dataWindow.since,
          dataWindowUntil: snapshot.dataWindow.until,
          status: 'complete',
          snapshot,
        },
        evidence: [
          {
            evidenceId: `ev_${suffix}`,
            sourcePlatform: 'github',
            sourceType: 'commit',
            url: 'https://x/1',
            layer: 'L1',
            claim: 'c',
            rawRef: 'r',
          },
        ],
        jobId,
      }),
    ).rejects.toThrow();

    // The profile insert ran first inside the transaction and must be gone: an orphan
    // profile is visible to /candidates and a still-active job gets reclaimed and
    // republished as a second profile row for the same login.
    expect(await s.profiles.getById(profileId)).toBeUndefined();
    const job = await s.jobs.getById(jobId);
    // still exactly where it started — in particular NOT succeeded with a dangling profileId
    expect(job?.status).toBe('queued');
    expect(job?.profileId).toBeNull();
    expect(await s.evidence.countByProfile(profileId)).toBe(1);
  });

  pgIt('fails an exhausted stale job instead of stranding it in queued', async (s) => {
    if (!basePgUrl) throw new Error('PG url not initialized');
    const suffix = randomUUID().slice(0, 8);
    const exhaustedId = `job_exh_${suffix}`;
    const retryableId = `job_ret_${suffix}`;
    // 两条任务用**不同 login**：latestActiveBySubject 按 login 查，共用 login 时
    // 被重新排队的那条会盖住断言，看不出"耗尽的那条已不再被当作活跃任务"。
    const exhaustedLogin = `u_exh_${suffix}`;
    const retryableLogin = `u_ret_${suffix}`;
    await s.jobs.create({ id: exhaustedId, subjectLogin: exhaustedLogin });
    await s.jobs.create({ id: retryableId, subjectLogin: retryableLogin });

    const tenMinAgo = new Date(Date.now() - 10 * 60_000).toISOString();
    const backdate = openPostgres(basePgUrl, { max: 2 });
    try {
      // attempts=3 == the default cap => must go terminal; attempts=1 => must be requeued.
      await backdate.client.unsafe(
        `update analysis_jobs set status='running', attempts=3, claimed_by='w', started_at=$1 where id=$2`,
        [tenMinAgo, exhaustedId],
      );
      await backdate.client.unsafe(
        `update analysis_jobs set status='running', attempts=1, claimed_by='w', started_at=$1 where id=$2`,
        [tenMinAgo, retryableId],
      );
    } finally {
      await backdate.client.end({ timeout: 5 });
    }

    const moved = await s.jobs.reclaimStaleRunning(5 * 60_000);
    expect(moved).toBeGreaterThanOrEqual(2);
    const exhausted = await s.jobs.getById(exhaustedId);
    expect(exhausted?.status).toBe('failed');
    expect(exhausted?.errorMessage).toContain('retry budget is exhausted');
    // the retryable one is genuinely still in play
    expect((await s.jobs.getById(retryableId))?.status).toBe('queued');
    expect(await s.jobs.latestActiveBySubject('github', retryableLogin)).toBeDefined();
    // the exhausted one is terminal, so it must no longer be reported as active —
    // this is what stops the client's poll from spinning forever
    expect(await s.jobs.latestActiveBySubject('github', exhaustedLogin)).toBeUndefined();
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

  // 回归（生产 2026-10-03 实锤）：WWR RSS 同一岗位在一次抓取里列了两次，
  // 已有行的两份拷贝同进 ON CONFLICT DO UPDATE 批次会报 21000
  // "ON CONFLICT DO UPDATE command cannot affect row a second time"。
  // 仓储必须在组批前按派生主键去重，并把重复折叠成一次计数。
  pgIt('collapses in-batch duplicates by derived id instead of failing ON CONFLICT DO UPDATE', async (s) => {
    const suffix = randomUUID().slice(0, 8);
    const base = {
      jobId: `dup_${suffix}`,
      source: 'greenhouse' as const,
      sourceUrl: `https://example.com/${suffix}/dup`,
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

    // 修复前这里抛 21000（同一 DO UPDATE 语句内同一冲突目标出现两次）。
    const dupRun = await s.jobPostings.upsertBatch(
      [{ ...base, title: 'Changed Title' }, { ...base, title: 'Changed Title' }],
      '2026-09-11T00:00:00.000Z',
    );
    expect(dupRun).toEqual({ inserted: 0, updated: 1, unchanged: 0 });

    const rows = await s.jobPostings.search({ sources: ['greenhouse'], limit: 500 });
    const mine = rows.filter((p) => p.sourceUrl === base.sourceUrl);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.title).toBe('Changed Title');
    expect(mine[0]!.firstSeenAt).toBe('2026-09-10T00:00:00.000Z');
  });

  // 回归（生产 2026-10-10 实锤）：PG upsertBatch 的行映射漏了 searchRunId
  // （SQLite 实现有），指令式搜岗新入库岗位的 search_run_id 恒为 NULL，
  // GET /agent/search/:id/results 在生产（PG）永远返回空。
  pgIt('persists searchRunId on insert and refreshes it on content update', async (s) => {
    const suffix = randomUUID().slice(0, 8);
    const base = {
      jobId: `sr_${suffix}`,
      source: 'websearch' as const,
      sourceUrl: `https://example.com/${suffix}/job`,
      title: 'Java Backend Engineer',
      company: `SR Co ${suffix}`,
      location: 'Shenzhen',
      remote: true,
      salaryMin: null,
      salaryMax: null,
      salaryCurrency: null,
      tags: ['java', 'backend'],
      description: 'd',
      postedAt: '2026-10-01T00:00:00.000Z',
      fetchedAt: '2026-10-10T00:00:00.000Z',
      normalizedKey: `nk_sr_${suffix}`,
      searchRunId: 'srun-first',
    };

    const first = await s.jobPostings.upsertBatch([base], '2026-10-10T00:00:00.000Z');
    expect(first.inserted).toBe(1);
    const byRun = await s.jobPostings.listBySearchRun('srun-first');
    expect(byRun.some((p) => p.sourceUrl === base.sourceUrl)).toBe(true);

    // 内容无变化：只刷 last_seen，保留原 run 关联（即便本批带了新 run id）
    const unchanged = await s.jobPostings.upsertBatch(
      [{ ...base, searchRunId: 'srun-second' }],
      '2026-10-11T00:00:00.000Z',
    );
    expect(unchanged.unchanged).toBe(1);
    const stillFirst = await s.jobPostings.listBySearchRun('srun-first');
    expect(stillFirst.some((p) => p.sourceUrl === base.sourceUrl)).toBe(true);

    // 内容变化：updated 分支刷新为新 run
    const updated = await s.jobPostings.upsertBatch(
      [{ ...base, title: 'Senior Java Backend Engineer', searchRunId: 'srun-third' }],
      '2026-10-12T00:00:00.000Z',
    );
    expect(updated.updated).toBe(1);
    const byThird = await s.jobPostings.listBySearchRun('srun-third');
    expect(byThird.some((p) => p.sourceUrl === base.sourceUrl)).toBe(true);
  });

  // 决策 #25（B3-a，2026-10-13）：招聘方自建 JD 的隐私不变量在 Postgres 上同口径。
  // 双方言各有一份 search/countBySource/markStale 实现，SQLite 单测覆盖不到这一侧。
  pgIt('keeps recruiter-owned JDs out of the public pool on Postgres too', async (s) => {
    const suffix = randomUUID().slice(0, 8);
    const accountId = `acct-pg-${suffix}`;
    const poolUrl = `https://example.com/${suffix}/pg-pool`;
    await s.jobPostings.upsertBatch(
      [
        {
          jobId: `pool_${suffix}`,
          source: 'greenhouse' as const,
          sourceUrl: poolUrl,
          title: 'Backend Engineer',
          company: `PG Co ${suffix}`,
          location: 'Remote',
          remote: true,
          salaryMin: null,
          salaryMax: null,
          salaryCurrency: null,
          tags: ['go'],
          description: 'd',
          postedAt: '2026-01-01T00:00:00.000Z',
          fetchedAt: '2026-01-01T00:00:00.000Z',
          normalizedKey: `nk_${suffix}`,
        },
      ],
      '2026-01-01T00:00:00.000Z',
    );
    const owned = await s.jobPostings.insertOwned(
      {
        title: 'Staff Agent Engineer',
        company: `In-house ${suffix}`,
        remote: false,
        tags: ['typescript', 'agents'],
        description: 'Own our internal agent platform.',
        postedAt: '2026-01-01T00:00:00.000Z',
        fetchedAt: '2026-01-01T00:00:00.000Z',
        createdByAccountId: accountId,
      },
      '2026-01-01T00:00:00.000Z',
    );

    const pool = await s.jobPostings.search({ limit: 500 });
    expect(pool.some((p) => p.sourceUrl === owned.sourceUrl)).toBe(false);
    const counts = await s.jobPostings.countBySource();
    expect(counts.recruiter).toBeUndefined();
    const mine = await s.jobPostings.search({ ownerAccountId: accountId, limit: 500 });
    expect(mine.map((p) => p.id)).toEqual([owned.id]);

    // 清扫照常作用于公开池（正对照），但永不自动下线自建 JD
    await s.jobPostings.markStale('2026-06-01T00:00:00.000Z');
    const retiredPool = await s.jobPostings.getById(
      pool.find((p) => p.sourceUrl === poolUrl)?.id ?? owned.id,
    );
    expect(retiredPool?.status).toBe('inactive');
    const stillActive = await s.jobPostings.search({ ownerAccountId: accountId, status: 'active' });
    expect(stillActive.map((p) => p.id)).toEqual([owned.id]);

    // 行级归属：别人的账号 retire 不动我的行
    const retireStamp = '2026-10-13T00:00:00.000Z';
    expect(
      await s.jobPostings.retireOwned(owned.id, `acct-other-${suffix}`, retireStamp),
    ).toBeUndefined();
    const retired = await s.jobPostings.retireOwned(owned.id, accountId, retireStamp);
    expect(retired?.status).toBe('inactive');
  });

  // usage_events（迁移 038，成本回采）：PG 方言对等验证——insert、COALESCE 聚合、
  // ::timestamptz 自然日 bucket、tsGte/tsLt 文本时间比较（事务池化串下不得 42883）。
  // 全部断言按带随机后缀的 accountId 过滤隔离，连跑同一库不假红。
  pgIt('inserts usage events and aggregates them consistently on Postgres', async (s) => {
    const suffix = randomUUID().slice(0, 8);
    const acct = `acct-usg-${suffix}`;
    const base = {
      accountId: acct,
      provider: null,
      model: null,
      promptTokens: null,
      completionTokens: null,
      quantity: null,
    };
    await s.usageEvents.insert({
      ...base,
      id: `usg-pg-${suffix}-1`,
      category: 'llm',
      feature: 'cover_letter',
      billingSource: 'builtin',
      promptTokens: 100,
      completionTokens: 50,
      createdAt: '2026-10-13T23:30:00.000Z',
    });
    await s.usageEvents.insert({
      ...base,
      id: `usg-pg-${suffix}-2`,
      category: 'llm',
      feature: 'cover_letter',
      billingSource: 'byok',
      promptTokens: 200,
      completionTokens: 80,
      createdAt: '2026-10-14T00:30:00.000Z',
    });
    await s.usageEvents.insert({
      ...base,
      id: `usg-pg-${suffix}-3`,
      category: 'search',
      feature: 'websearch',
      billingSource: 'platform',
      provider: 'tavily',
      quantity: 3,
      createdAt: '2026-10-14T02:00:00.000Z',
    });

    const rows = await s.usageEvents.summarize({
      sinceIso: '2026-10-13T00:00:00.000Z',
      untilIso: '2026-10-15T00:00:00.000Z',
      accountId: acct,
    });
    expect(rows).toEqual([
      { category: 'llm', feature: 'cover_letter', billingSource: 'builtin', events: 1, sumPromptTokens: 100, sumCompletionTokens: 50, sumQuantity: 0 },
      { category: 'llm', feature: 'cover_letter', billingSource: 'byok', events: 1, sumPromptTokens: 200, sumCompletionTokens: 80, sumQuantity: 0 },
      { category: 'search', feature: 'websearch', billingSource: 'platform', events: 1, sumPromptTokens: 0, sumCompletionTokens: 0, sumQuantity: 3 },
    ]);

    // until 排他（文本时间比较不 42883）：切到 10-14 00:00 只剩第一条。
    const head = await s.usageEvents.summarize({
      sinceIso: '2026-10-13T00:00:00.000Z',
      untilIso: '2026-10-14T00:00:00.000Z',
      accountId: acct,
    });
    expect(head).toHaveLength(1);
    expect(head[0]).toMatchObject({ billingSource: 'builtin', sumPromptTokens: 100 });

    // UTC 自然日 bucket：10-13 与 10-14 两天、按 category 升序。
    const days = await s.usageEvents.summarizeDaily({
      sinceIso: '2026-10-13T00:00:00.000Z',
      untilIso: '2026-10-15T00:00:00.000Z',
      accountId: acct,
    });
    expect(days).toEqual([
      { day: '2026-10-13', category: 'llm', events: 1, sumPromptTokens: 100, sumCompletionTokens: 50, sumQuantity: 0 },
      { day: '2026-10-14', category: 'llm', events: 1, sumPromptTokens: 200, sumCompletionTokens: 80, sumQuantity: 0 },
      { day: '2026-10-14', category: 'search', events: 1, sumPromptTokens: 0, sumCompletionTokens: 0, sumQuantity: 3 },
    ]);
  });

  // funnel_events（迁移 040，验证漏斗）：PG 方言对等验证——recordView 30 分钟去重的
  // 文本时间比较（不得 42883）、COUNT DISTINCT 忽略 NULL、NULL 组 CASE WHEN、聚合列
  // string→number coercion、UTC 自然日 bucket。表无账号列可过滤，故聚合用增量断言，
  // sessionRef/主键带随机后缀，连跑同一库不假红。
  pgIt('inserts funnel events and aggregates them consistently on Postgres', async (s) => {
    const suffix = randomUUID().slice(0, 8);
    const sid = `sid-pg-${suffix}`;
    const profileId = randomUUID();
    const SINCE = '2026-10-13T00:00:00.000Z';
    const UNTIL = '2026-10-15T00:00:00.000Z';
    let n = 0;
    const at = (iso: string, over: Partial<FunnelEventRecord> = {}): FunnelEventRecord => ({
      id: `fe-pg-${suffix}-${(n += 1)}`,
      event: 'report_viewed',
      sessionRef: sid,
      profileId,
      requester: null,
      createdAt: iso,
      ...over,
    });

    // recordView 30 分钟 (session, profile) 去重：窗口内 deduped、滑出窗口重新计数。
    const W = 30 * 60 * 1000;
    expect(await s.funnelEvents.recordView(at('2026-10-14T12:00:00.000Z'), W)).toBe('inserted');
    expect(await s.funnelEvents.recordView(at('2026-10-14T12:10:00.000Z'), W)).toBe('deduped');
    expect(await s.funnelEvents.recordView(at('2026-10-14T12:31:00.000Z'), W)).toBe('inserted');

    // 聚合增量（recordView 的两条 viewed 已在基线内，对下方两个事件的增量无影响）。
    const base = await s.funnelEvents.summarize({ sinceIso: SINCE, untilIso: UNTIL });
    const baseDays = await s.funnelEvents.summarizeDaily({ sinceIso: SINCE, untilIso: UNTIL });
    await s.funnelEvents.insert(
      at('2026-10-13T23:30:00.000Z', { event: 'analyze_enqueued', profileId: null, requester: 'user' }),
    );
    await s.funnelEvents.insert(
      at('2026-10-14T02:00:00.000Z', { event: 'share_clicked', sessionRef: null }),
    );
    const after = await s.funnelEvents.summarize({ sinceIso: SINCE, untilIso: UNTIL });
    const afterDays = await s.funnelEvents.summarizeDaily({ sinceIso: SINCE, untilIso: UNTIL });

    const delta = (event: FunnelEventName) => {
      const b = base.find((r) => r.event === event) ?? { events: 0, distinctSessions: 0, nullSessions: 0 };
      const a = after.find((r) => r.event === event)!;
      return {
        events: a.events - b.events,
        distinctSessions: a.distinctSessions - b.distinctSessions,
        nullSessions: a.nullSessions - b.nullSessions,
      };
    };
    expect(delta('analyze_enqueued')).toEqual({ events: 1, distinctSessions: 1, nullSessions: 0 });
    // share_clicked 无会话标识：不进 distinct、单独落 NULL 组。
    expect(delta('share_clicked')).toEqual({ events: 1, distinctSessions: 0, nullSessions: 1 });

    const dayDelta = (day: string, event: FunnelEventName) => {
      const b = baseDays.find((r) => r.day === day && r.event === event)?.events ?? 0;
      const a = afterDays.find((r) => r.day === day && r.event === event)?.events ?? 0;
      return a - b;
    };
    expect(dayDelta('2026-10-13', 'analyze_enqueued')).toBe(1);
    expect(dayDelta('2026-10-14', 'share_clicked')).toBe(1);
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
