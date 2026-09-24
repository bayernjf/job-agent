/**
 * 演示配额 API 层并发压测（design-demo-mode-20260915 §3：会话硬配额 + IP 滑窗）。
 *
 * storage 层已在真实竞态下验证过 acquireAnalyzeSlot 零超发（见
 * packages/storage postgres-behavior.test.ts 与 demo-sessions.test.ts）。本文件在
 * **API 编排层**通过 Hono app.request() 并发打 /analyze，守护端到端不变量：
 *   1. 同一会话并发 N 个单源分析，成功数恰好等于配额（3），多一个都不放行；
 *   2. platform=all 按 fusionAnalyzeCost(=2) 加权原子扣减，不足整单拒绝、不部分扣；
 *   3. 不同 IP/会话的配额桶相互隔离，互不串号；
 *   4. all(2) + 单源(1) 混合恰好打满 3。
 *
 * 全部内存 SQLite + 固定 now/IP 盐，零真实网络；/analyze 只建 queued job（不立即采集），
 * 故无需 fake GitHub source。每个并发请求使用唯一 username，避免 active-job 去重干扰配额计数。
 */
import { describe, expect, it } from 'vitest';
import { DEMO_ERROR_CODES } from '@jobagent/shared';
import { createStorage, type StorageContext } from '@jobagent/storage';
import { createApp } from './index.js';
import type { DemoConfig } from './demo-config.js';

const NOW = '2026-09-24T12:00:00.000Z';

function makeConfig(overrides: Partial<DemoConfig> = {}): DemoConfig {
  return {
    sessionTtlMs: 24 * 60 * 60 * 1000,
    analyzeQuota: 3,
    fusionAnalyzeCost: 2,
    sessionRatePerHour: 5,
    analyzeRatePerHour: 10, // 单 IP 每小时 10 次；本文件并发量均低于此，专注验证会话硬配额
    matchRatePerHour: 60,
    maxConcurrent: 1,
    backoffMs: 15_000,
    ipSalt: 'fixed-concurrency-salt',
    presetLogins: [],
    corsAllowOrigins: [],
    trustProxy: true,
    isProduction: false,
    ...overrides,
  };
}

async function freshRepos(): Promise<StorageContext> {
  return createStorage({ sqlitePath: ':memory:' });
}

async function makeApp(repos: StorageContext, overrides: Partial<DemoConfig> = {}) {
  return createApp({ repos, now: () => NOW, demoConfig: makeConfig(overrides) });
}

function jsonHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { 'Content-Type': 'application/json', ...extra };
}

/** 走真实 POST /demo/sessions 建会话，返回 "jobagent_demo=..." Cookie 串。 */
async function startSession(
  app: Awaited<ReturnType<typeof createApp>>,
  ip: string,
): Promise<string> {
  const res = await app.request('/demo/sessions', {
    method: 'POST',
    headers: jsonHeaders({ 'x-forwarded-for': ip }),
  });
  expect(res.status).toBe(201);
  return res.headers.get('set-cookie')!.split(';')[0]!;
}

type AnalyzePlatform = 'github' | 'gitee' | 'all';

async function analyze(
  app: Awaited<ReturnType<typeof createApp>>,
  username: string,
  cookie: string,
  ip: string,
  platform?: AnalyzePlatform,
) {
  return app.request('/analyze', {
    method: 'POST',
    headers: jsonHeaders({
      'x-forwarded-for': ip,
      Cookie: cookie,
    }),
    body: JSON.stringify({ username, ...(platform ? { platform } : {}) }),
  });
}

async function demoMe(
  app: Awaited<ReturnType<typeof createApp>>,
  cookie: string,
): Promise<{ analyzeUsed: number; analyzeRemaining: number }> {
  const res = await app.request('/demo/me', { headers: jsonHeaders({ Cookie: cookie }) });
  expect(res.status).toBe(200);
  return (await res.json()) as any;
}

describe('demo analyze quota under concurrent API load', () => {
  it('never issues more than analyzeQuota(=3) single-source slots to one session under a burst', async () => {
    const repos = await freshRepos();
    const app = await makeApp(repos);
    const cookie = await startSession(app, '10.0.0.1');

    // 6 个并发单源分析（唯一 username，避免 active 去重）；只有 3 个应成功。
    const responses = await Promise.all(
      Array.from({ length: 6 }, (_, i) => analyze(app, `burst-${i}`, cookie, '10.0.0.1')),
    );
    const statuses = responses.map((r) => r.status);
    const created = statuses.filter((s) => s === 201);
    const exhausted = statuses.filter((s) => s === 429);
    expect(created).toHaveLength(3);
    expect(exhausted).toHaveLength(3);

    // 每个被拒响应都必须是稳定的配额错误码，且明确剩余为 0
    for (const res of responses.filter((r) => r.status === 429)) {
      const body = (await res.json()) as any;
      expect(body.code).toBe(DEMO_ERROR_CODES.quotaExceeded);
      expect(body.analyzeRemaining).toBe(0);
    }

    // 恰好 3 个 queued job 落库（一个成功请求对应一个 job）
    const queued = await repos.jobs.listQueued();
    expect(queued).toHaveLength(3);

    const me = await demoMe(app, cookie);
    expect(me.analyzeUsed).toBe(3);
    expect(me.analyzeRemaining).toBe(0);
  });

  it('charges fused platform=all cost(=2) atomically: one granted, the rest rejected with no partial deduct', async () => {
    const repos = await freshRepos();
    const app = await makeApp(repos);
    const cookie = await startSession(app, '10.0.0.2');

    // 配额 3、单次 all 成本 2：并发 3 个 all，仅 1 个能满足 count+2<=3，其余整单拒绝。
    const responses = await Promise.all(
      Array.from({ length: 3 }, (_, i) => analyze(app, `fuse-${i}`, cookie, '10.0.0.2', 'all')),
    );
    const statuses = responses.map((r) => r.status);
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    const rejected = responses.filter((r) => r.status === 429);
    expect(rejected).toHaveLength(2);
    for (const res of rejected) {
      const body = (await res.json()) as any;
      expect(body.code).toBe(DEMO_ERROR_CODES.quotaExceeded);
    }

    // 只扣了一次 cost=2，没有部分扣减（不是 3、也不是 4）
    const me = await demoMe(app, cookie);
    expect(me.analyzeUsed).toBe(2);
    expect(me.analyzeRemaining).toBe(1);

    const queued = await repos.jobs.listQueued();
    expect(queued).toHaveLength(1);
    expect(queued[0]!.subjectPlatform).toBe('all');
  });

  it('isolates quota buckets across distinct sessions / IPs (no cross-talk under parallel bursts)', async () => {
    const repos = await freshRepos();
    const app = await makeApp(repos);
    const cookieA = await startSession(app, '172.16.0.1');
    const cookieB = await startSession(app, '172.16.0.2');

    // 两个不同 IP 的会话各自并发 4 个单源（全局唯一 username），各应恰好 3 成功 / 1 拒绝。
    const [resultsA, resultsB] = await Promise.all([
      Promise.all(
        Array.from({ length: 4 }, (_, i) => analyze(app, `alpha-${i}`, cookieA, '172.16.0.1')),
      ),
      Promise.all(
        Array.from({ length: 4 }, (_, i) => analyze(app, `beta-${i}`, cookieB, '172.16.0.2')),
      ),
    ]);

    const count = (rs: Response[], code: number) => rs.filter((r) => r.status === code).length;
    expect(count(resultsA, 201)).toBe(3);
    expect(count(resultsA, 429)).toBe(1);
    expect(count(resultsB, 201)).toBe(3);
    expect(count(resultsB, 429)).toBe(1);

    // 两桶独立：各自用满 3，互不借用、互不影响
    const meA = await demoMe(app, cookieA);
    const meB = await demoMe(app, cookieB);
    expect(meA.analyzeUsed).toBe(3);
    expect(meB.analyzeUsed).toBe(3);

    const queued = await repos.jobs.listQueued();
    expect(queued).toHaveLength(6);
  });

  it('fills the quota exactly with one fused all(cost 2) followed by one single-source(cost 1)', async () => {
    const repos = await freshRepos();
    const app = await makeApp(repos);
    const cookie = await startSession(app, '10.0.0.3');

    // 串行、确定性地验证混合成本：all 扣 2（剩 1）→ 单源扣 1（剩 0）→ 再单源被拒。
    const allRes = await analyze(app, 'mix-fused', cookie, '10.0.0.3', 'all');
    expect(allRes.status).toBe(201);

    const singleRes = await analyze(app, 'mix-single', cookie, '10.0.0.3', 'github');
    expect(singleRes.status).toBe(201);

    const deniedRes = await analyze(app, 'mix-denied', cookie, '10.0.0.3', 'gitee');
    expect(deniedRes.status).toBe(429);
    const deniedBody = (await deniedRes.json()) as any;
    expect(deniedBody.code).toBe(DEMO_ERROR_CODES.quotaExceeded);

    const me = await demoMe(app, cookie);
    expect(me.analyzeUsed).toBe(3);
    expect(me.analyzeRemaining).toBe(0);
  });
});
