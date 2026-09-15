/**
 * 演示模式 API 集成测试（design-demo-mode-20260915 §14 api 清单）。
 * 内存 SQLite + createApp 注入，零真实网络；固定 now 与固定 IP 盐保证确定性。
 */
import { describe, expect, it } from 'vitest';
import {
  DEMO_ERROR_CODES,
  type AbilityProfile,
} from '@jobagent/shared';
import { createStorage, type StorageContext } from '@jobagent/storage';
import { createApp, type ApiRepos } from './index.js';
import type { DemoConfig } from './demo-config.js';

const NOW = '2026-09-15T12:00:00.000Z';

function makeConfig(overrides: Partial<DemoConfig> = {}): DemoConfig {
  return {
    sessionTtlMs: 7 * 24 * 60 * 60 * 1000,
    analyzeQuota: 3,
    sessionRatePerHour: 5,
    analyzeRatePerHour: 10,
    matchRatePerHour: 60,
    maxConcurrent: 1,
    backoffMs: 15_000,
    ipSalt: 'fixed-test-salt',
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

async function makeApp(repos: ApiRepos, overrides: Partial<DemoConfig> = {}) {
  return createApp({ repos, now: () => NOW, demoConfig: makeConfig(overrides) });
}

function jsonHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { 'Content-Type': 'application/json', ...extra };
}

/** 走真实 POST /demo/sessions 建会话，返回可直接放入 Cookie 头的 "jobagent_demo=..."。 */
async function startSession(
  app: Awaited<ReturnType<typeof createApp>>,
  ip = '1.2.3.4',
): Promise<string> {
  const res = await app.request('/demo/sessions', {
    method: 'POST',
    headers: jsonHeaders({ 'x-forwarded-for': ip }),
  });
  expect(res.status).toBe(201);
  const setCookie = res.headers.get('set-cookie')!;
  expect(setCookie).toBeTruthy();
  return setCookie.split(';')[0]!;
}

function sessionIdOf(cookie: string): string {
  return cookie.split('=')[1]!;
}

function minimalProfile(login: string): AbilityProfile {
  return {
    profileId: `prof-${login}`,
    analyzerVersion: 'schema-0.1-engine-0.1.0',
    generatedAt: NOW,
    dataWindow: { since: '2025-09-15T00:00:00.000Z', until: NOW },
    analysisLayers: ['L0', 'L1'],
    subject: { platform: 'github', login, profileUrl: `https://github.com/${login}`, claimed: false },
    summary: { headline: 'Demo developer' },
    skillTags: [],
    activity: { longevityMonths: 12 },
    collaboration: { evidenceRefs: [] },
    authenticity: { status: 'likely_authentic', confidence: 0.8, signals: [] },
    interviewQuestions: [],
    caveats: [],
  };
}

async function insertCompleteProfile(repos: StorageContext, login: string): Promise<void> {
  const snapshot = minimalProfile(login);
  await repos.profiles.insert({
    id: snapshot.profileId,
    analyzerVersion: snapshot.analyzerVersion,
    subjectLogin: login,
    subjectClaimed: false,
    dataWindowSince: snapshot.dataWindow.since,
    dataWindowUntil: snapshot.dataWindow.until,
    status: 'complete',
    snapshot,
  });
}

async function analyze(
  app: Awaited<ReturnType<typeof createApp>>,
  username: string,
  cookie?: string,
  ip = '1.2.3.4',
) {
  return app.request('/analyze', {
    method: 'POST',
    headers: jsonHeaders({
      'x-forwarded-for': ip,
      ...(cookie ? { Cookie: cookie } : {}),
    }),
    body: JSON.stringify({ username }),
  });
}

// ─── POST /demo/sessions ────────────────────────────────────────────────

describe('POST /demo/sessions', () => {
  it('creates a session with HttpOnly/Lax/Max-Age cookie and quota body', async () => {
    const repos = await freshRepos();
    const app = await makeApp(repos);
    const res = await app.request('/demo/sessions', {
      method: 'POST',
      headers: jsonHeaders({ 'x-forwarded-for': '1.2.3.4' }),
    });

    expect(res.status).toBe(201);
    const setCookie = res.headers.get('set-cookie')!;
    expect(setCookie).toContain('jobagent_demo=demo-');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).toContain('Path=/');
    expect(setCookie).toContain('Max-Age=604800');
    // 本地非生产不带 Secure
    expect(setCookie).not.toContain('Secure');

    const body = (await res.json()) as any;
    expect(body.kind).toBe('demo');
    expect(body.analyzeQuota).toBe(3);
    expect(body.analyzeUsed).toBe(0);
    expect(body.analyzeRemaining).toBe(3);
    expect(body.expiresAt).toBe('2026-09-22T12:00:00.000Z');
  });

  it('is idempotent for an already-active demo session', async () => {
    const repos = await freshRepos();
    const app = await makeApp(repos);
    const cookie = await startSession(app);
    const first = (await (await app.request('/demo/me', { headers: { Cookie: cookie } })).json()) as any;

    const res = await app.request('/demo/sessions', {
      method: 'POST',
      headers: jsonHeaders({ Cookie: cookie, 'x-forwarded-for': '1.2.3.4' }),
    });
    expect(res.status).toBe(200); // 幂等返回 200，不新建
    const body = (await res.json()) as any;
    expect(body.sessionId).toBe(first.sessionId);
  });

  it('returns 429 DEMO_RATE_LIMITED when an IP exceeds the session window', async () => {
    const repos = await freshRepos();
    const app = await makeApp(repos, { sessionRatePerHour: 2 });
    const headers = jsonHeaders({ 'x-forwarded-for': '9.9.9.9' });
    expect((await app.request('/demo/sessions', { method: 'POST', headers })).status).toBe(201);
    expect((await app.request('/demo/sessions', { method: 'POST', headers })).status).toBe(201);
    const third = await app.request('/demo/sessions', { method: 'POST', headers });
    expect(third.status).toBe(429);
    const body = (await third.json()) as any;
    expect(body.code).toBe(DEMO_ERROR_CODES.rateLimited);
    expect(body.bucket).toBe('session');
    expect(body.retryAfterSeconds).toBe(3600);
  });
});

// ─── GET /demo/me ───────────────────────────────────────────────────────

describe('GET /demo/me', () => {
  it('reports anonymous without a cookie and degrades a bad cookie to anonymous', async () => {
    const repos = await freshRepos();
    const app = await makeApp(repos);

    const none = (await (await app.request('/demo/me')).json()) as any;
    expect(none).toEqual({ kind: 'anonymous' });

    const bad = (await (
      await app.request('/demo/me', { headers: { Cookie: 'jobagent_demo=does-not-exist' } })
    ).json()) as any;
    expect(bad).toEqual({ kind: 'anonymous' });
  });

  it('reports quota state for a valid session', async () => {
    const repos = await freshRepos();
    const app = await makeApp(repos);
    const cookie = await startSession(app);
    const me = (await (await app.request('/demo/me', { headers: { Cookie: cookie } })).json()) as any;
    expect(me.kind).toBe('demo');
    expect(me.analyzeQuota).toBe(3);
    expect(me.analyzeUsed).toBe(0);
    expect(me.analyzeRemaining).toBe(3);
    expect(me.expiresAt).toBeTruthy();
  });
});

// ─── POST /demo/exit ────────────────────────────────────────────────────

describe('POST /demo/exit', () => {
  it('marks the session exited and clears the cookie', async () => {
    const repos = await freshRepos();
    const app = await makeApp(repos);
    const cookie = await startSession(app);

    const res = await app.request('/demo/exit', {
      method: 'POST',
      headers: jsonHeaders({ Cookie: cookie }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as any).toEqual({ kind: 'anonymous' });
    expect(res.headers.get('set-cookie')!).toContain('Max-Age=0');

    // 退出后同 Cookie 已降级为 anonymous
    const me = (await (await app.request('/demo/me', { headers: { Cookie: cookie } })).json()) as any;
    expect(me.kind).toBe('anonymous');
  });

  it('is a no-op for anonymous callers', async () => {
    const repos = await freshRepos();
    const app = await makeApp(repos);
    const res = await app.request('/demo/exit', { method: 'POST' });
    expect(res.status).toBe(200);
    expect((await res.json()) as any).toEqual({ kind: 'anonymous' });
  });
});

// ─── GET /demo/presets ──────────────────────────────────────────────────

describe('GET /demo/presets', () => {
  it('mixes ready and missing presets', async () => {
    const repos = await freshRepos();
    await insertCompleteProfile(repos, 'ready-user');
    const app = await makeApp(repos, {
      presetLogins: [
        { platform: 'github', login: 'ready-user' },
        { platform: 'github', login: 'missing-user' },
      ],
    });

    const res = await app.request('/demo/presets');
    expect(res.status).toBe(200);
    const presets = (await res.json()) as any[];
    expect(presets).toHaveLength(2);
    expect(presets[0]).toMatchObject({
      platform: 'github',
      login: 'ready-user',
      authenticity: 'likely_authentic',
      ready: true,
    });
    expect(presets[0]!.profileId).toBe('prof-ready-user');
    expect(presets[1]).toEqual({
      platform: 'github',
      login: 'missing-user',
      authenticity: 'unknown',
      profileId: null,
      ready: false,
    });
  });
});

// ─── POST /analyze gating ───────────────────────────────────────────────

describe('POST /analyze demo gating', () => {
  it('(1) serves a cached profile to anonymous without creating a session', async () => {
    const repos = await freshRepos();
    await insertCompleteProfile(repos, 'cached-anon');
    const app = await makeApp(repos);

    const res = await analyze(app, 'cached-anon');
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.cached).toBe(true);
    expect((await repos.jobs.listQueued())).toHaveLength(0);
  });

  it('(2) rejects an anonymous new analysis with 403 DEMO_REQUIRED', async () => {
    const repos = await freshRepos();
    const app = await makeApp(repos);
    const res = await analyze(app, 'brand-new-user');
    expect(res.status).toBe(403);
    const body = (await res.json()) as any;
    expect(body.code).toBe(DEMO_ERROR_CODES.demoRequired);
    expect((await repos.jobs.listQueued())).toHaveLength(0);
  });

  it('(3) does not consume quota when a demo hits the profile cache', async () => {
    const repos = await freshRepos();
    await insertCompleteProfile(repos, 'cached-demo');
    const app = await makeApp(repos);
    const cookie = await startSession(app);

    const res = await analyze(app, 'cached-demo', cookie);
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).cached).toBe(true);

    const session = await repos.demoSessions.getActive(sessionIdOf(cookie), NOW);
    expect(session!.analyzeCount).toBe(0);
  });

  it('(4) does not consume quota on active-job dedup', async () => {
    const repos = await freshRepos();
    const app = await makeApp(repos);
    const cookie = await startSession(app);
    const sid = sessionIdOf(cookie);
    // 预置一个在跑的 demo job
    await repos.jobs.create({
      id: 'job-active',
      subjectPlatform: 'github',
      subjectLogin: 'in-flight',
      requesterKind: 'demo',
      demoSessionId: sid,
    });

    const res = await analyze(app, 'in-flight', cookie);
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).dedup).toBe(true);
    const session = await repos.demoSessions.getActive(sid, NOW);
    expect(session!.analyzeCount).toBe(0);
  });

  it('(5) creates demo jobs within quota, records requester and touched logins', async () => {
    const repos = await freshRepos();
    const app = await makeApp(repos);
    const cookie = await startSession(app);
    const sid = sessionIdOf(cookie);

    const r1 = await analyze(app, 'user-a', cookie);
    const r2 = await analyze(app, 'user-b', cookie);
    const r3 = await analyze(app, 'user-c', cookie);
    expect([r1.status, r2.status, r3.status]).toEqual([201, 201, 201]);
    expect(((await r1.json()) as any).demo.remaining).toBe(2);
    expect(((await r3.json()) as any).demo.remaining).toBe(0);

    const queued = await repos.jobs.listQueued();
    expect(queued).toHaveLength(3);
    for (const job of queued) {
      expect(job.requesterKind).toBe('demo');
      expect(job.demoSessionId).toBe(sid);
    }

    const session = await repos.demoSessions.getActive(sid, NOW);
    expect(session!.analyzeCount).toBe(3);
    expect(session!.analyzedLogins.map((l) => l.login)).toEqual([
      'user-a',
      'user-b',
      'user-c',
    ]);
  });

  it('(6) returns 429 DEMO_QUOTA_EXCEEDED with resetAt on the N+1th analysis', async () => {
    const repos = await freshRepos();
    const app = await makeApp(repos, { analyzeRatePerHour: 1000 });
    const cookie = await startSession(app);
    for (const u of ['a', 'b', 'c']) await analyze(app, u, cookie);

    const res = await analyze(app, 'd', cookie);
    expect(res.status).toBe(429);
    const body = (await res.json()) as any;
    expect(body.code).toBe(DEMO_ERROR_CODES.quotaExceeded);
    expect(body.analyzeQuota).toBe(3);
    expect(body.analyzeUsed).toBe(3);
    expect(body.analyzeRemaining).toBe(0);
    expect(body.resetAt).toBe('2026-09-22T12:00:00.000Z');
  });

  it('(7) returns 429 DEMO_RATE_LIMITED when the IP analyze window is full', async () => {
    const repos = await freshRepos();
    const app = await makeApp(repos, { analyzeRatePerHour: 2 });
    const cookie = await startSession(app);

    expect((await analyze(app, 'ip-a', cookie)).status).toBe(201);
    expect((await analyze(app, 'ip-b', cookie)).status).toBe(201);
    const third = await analyze(app, 'ip-c', cookie);
    expect(third.status).toBe(429);
    const body = (await third.json()) as any;
    expect(body.code).toBe(DEMO_ERROR_CODES.rateLimited);
    expect(body.bucket).toBe('analyze');
  });

  it('(8) releases the acquired slot when jobs.create throws', async () => {
    const base = await freshRepos();
    const cookie = await startSession(await makeApp(base));
    const sid = sessionIdOf(cookie);
    // 用原型链包装：保留实例/原型上的全部方法，仅覆盖 create 抛错
    const jobs = Object.create(base.jobs) as StorageContext['jobs'];
    jobs.create = async () => {
      throw new Error('db down');
    };
    const repos: ApiRepos = { ...base, jobs };
    const app = await makeApp(repos);

    // 先占用一个名额（证明补偿确实把 1 回退到 0），这里直接让首次 analyze 走到 create：
    const res = await analyze(app, 'will-fail', cookie);
    expect(res.status).toBe(500);
    // create 抛错后名额已补偿回 0，可再次使用
    const session = await base.demoSessions.getActive(sid, NOW);
    expect(session!.analyzeCount).toBe(0);
  });
});
