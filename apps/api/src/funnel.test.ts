/**
 * 验证漏斗埋点 API 测试（design-funnel-analytics-20261015 §7）。
 * 内存 SQLite + createApp 注入，零真实网络；固定 now 与固定 IP 盐保证确定性。
 *
 * - POST /analyze 三分支：demo/user 新建各恰好一条 analyze_enqueued、缓存命中一条
 *   analyze_cache_hit、去重复用与配额拦截零条；ja_sid 经 Cookie 串联 sessionRef。
 * - POST /funnel/events：合法 202（sessionRef 取自 ja_sid）、非法 event 400、
 *   伪造服务端三类事件 400、非 uuid profileId 400、IP 滑窗超限 429、
 *   仓储抛错仍 202（fail-open 到响应层）。
 */
import { describe, expect, it } from 'vitest';
import {
  FUNNEL_SESSION_COOKIE,
  type AbilityProfile,
  type RecordFunnelInput,
} from '@jobagent/shared';
import {
  createFunnelRecorder,
  createStorage,
  type FunnelRecorder,
  type IFunnelEventsRepository,
  type StorageContext,
} from '@jobagent/storage';
import { createApp, type ApiDeps } from './index.js';
import { FakeAuthProvider } from './fake-auth.js';
import type { OAuthProfile } from './auth-provider.js';
import { loadAuthConfig } from './auth-config.js';
import type { DemoConfig } from './demo-config.js';

const NOW = '2026-10-15T12:00:00.000Z';
const P1 = '11111111-1111-4111-8111-111111111111';

const USER: OAuthProfile = {
  platform: 'github',
  providerAccountId: '401',
  login: 'funnel-user',
  name: 'Funnel User',
  email: 'funnel-user@example.com',
  avatarUrl: 'https://example.com/funnel-user.png',
};

function makeConfig(overrides: Partial<DemoConfig> = {}): DemoConfig {
  return {
    sessionTtlMs: 24 * 60 * 60 * 1000,
    analyzeQuota: 3,
    fusionAnalyzeCost: 2,
    sessionRatePerHour: 5,
    analyzeRatePerHour: 10,
    matchRatePerHour: 60,
    subjectRatePerHour: 120,
    removalRatePerHour: 5,
    candidatesRatePerHour: 120,
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

/** 收集 record/recordView 入参的假 FunnelRecorder（断言埋点用）。 */
function fakeFunnelRecorder(): { calls: RecordFunnelInput[]; recorder: FunnelRecorder } {
  const calls: RecordFunnelInput[] = [];
  return {
    calls,
    recorder: {
      async record(input) {
        calls.push(input);
      },
      async recordView(input) {
        calls.push(input);
      },
    },
  };
}

async function setup(
  overrides: Partial<DemoConfig> = {},
  deps: Partial<ApiDeps> = {},
): Promise<{
  repos: StorageContext;
  app: Awaited<ReturnType<typeof createApp>>;
  funnel: { calls: RecordFunnelInput[]; recorder: FunnelRecorder };
}> {
  const repos = await createStorage({ sqlitePath: ':memory:' });
  const funnel = fakeFunnelRecorder();
  const app = await createApp({
    repos,
    now: () => NOW,
    demoConfig: makeConfig(overrides),
    authConfig: loadAuthConfig({}),
    githubAuthProvider: new FakeAuthProvider(USER),
    funnelRecorder: funnel.recorder,
    ...deps,
  });
  return { repos, app, funnel };
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
  return res.headers.get('set-cookie')!.split(';')[0]!;
}

async function loginAsUser(
  app: Awaited<ReturnType<typeof createApp>>,
): Promise<string> {
  const loginRes = await app.request('/auth/github/login');
  const stateCookie = (loginRes.headers.get('set-cookie') ?? '').split(';')[0]!;
  const state = decodeURIComponent(stateCookie.split('=')[1]!);
  const callbackRes = await app.request(
    `/auth/github/callback?state=${encodeURIComponent(state)}&code=fake-code`,
    { headers: { Cookie: stateCookie } },
  );
  return (callbackRes.headers.get('set-cookie') ?? '').split(';')[0]!;
}

function minimalProfile(login: string): AbilityProfile {
  return {
    profileId: `prof-${login}`,
    analyzerVersion: 'schema-0.1-engine-0.1.0',
    generatedAt: NOW,
    dataWindow: { since: '2025-10-15T00:00:00.000Z', until: NOW },
    analysisLayers: ['L0', 'L1'],
    subject: { platform: 'github', login, profileUrl: `https://github.com/${login}`, claimed: false },
    summary: { headline: 'Funnel developer' },
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

function analyze(
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

// ─── POST /analyze 埋点 ─────────────────────────────────────────────────

describe('POST /analyze funnel events', () => {
  it('demo 新建分析：恰好一条 analyze_enqueued（requester=demo，ja_sid 串联 sessionRef）', async () => {
    const { app, funnel } = await setup();
    const session = await startSession(app);
    const res = await analyze(app, 'octocat', `${session}; ${FUNNEL_SESSION_COOKIE}=sid-demo-1`);
    expect(res.status).toBe(201);

    expect(funnel.calls).toEqual([
      { event: 'analyze_enqueued', sessionRef: 'sid-demo-1', profileId: null, requester: 'demo' },
    ]);
  });

  it('登录用户新建分析：恰好一条 analyze_enqueued（requester=user，无 ja_sid 记 NULL 组）', async () => {
    const { app, funnel } = await setup();
    const session = await loginAsUser(app);
    const res = await analyze(app, 'octocat', session);
    expect(res.status).toBe(201);

    expect(funnel.calls).toEqual([
      { event: 'analyze_enqueued', sessionRef: null, profileId: null, requester: 'user' },
    ]);
  });

  it('缓存命中：一条 analyze_cache_hit（任何身份放行、不扣配额）；去重复用与配额拦截零条', async () => {
    const { repos, app, funnel } = await setup();
    await insertCompleteProfile(repos, 'cached-dev');
    const hit = await analyze(app, 'cached-dev');
    expect(hit.status).toBe(200);
    expect(await hit.json()).toMatchObject({ cached: true });
    expect(funnel.calls).toEqual([
      { event: 'analyze_cache_hit', sessionRef: null, profileId: null, requester: null },
    ]);

    // 去重复用：同主体 active 作业存在时第二次 analyze 走 dedup，不再记埋点。
    funnel.calls.length = 0;
    const session = await startSession(app, '2.3.4.5');
    const first = await analyze(app, 'fresh-dev', session, '2.3.4.5');
    expect(first.status).toBe(201);
    const second = await analyze(app, 'fresh-dev', session, '2.3.4.5');
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ dedup: true });
    expect(funnel.calls).toHaveLength(1); // 只有首次入队那一条

    // 配额拦截：剩余不足整单拒绝，不记埋点。
    funnel.calls.length = 0;
    const { app: tightApp, funnel: tightFunnel } = await setup({ analyzeQuota: 0 });
    const tightSession = await startSession(tightApp, '3.4.5.6');
    const blocked = await analyze(tightApp, 'fresh-dev', tightSession, '3.4.5.6');
    expect(blocked.status).toBe(429);
    expect(tightFunnel.calls).toHaveLength(0);
  });
});

// ─── POST /funnel/events ────────────────────────────────────────────────

describe('POST /funnel/events', () => {
  function post(app: Awaited<ReturnType<typeof createApp>>, body: unknown, cookie?: string) {
    return app.request('/funnel/events', {
      method: 'POST',
      headers: jsonHeaders({
        'x-forwarded-for': '1.2.3.4',
        ...(cookie ? { Cookie: cookie } : {}),
      }),
      body: JSON.stringify(body),
    });
  }

  it('合法 share_clicked → 202，sessionRef 取自 ja_sid、profileId 透传', async () => {
    const { app, funnel } = await setup();
    const res = await post(
      app,
      { event: 'share_clicked', profileId: P1 },
      `${FUNNEL_SESSION_COOKIE}=sid-share-1`,
    );
    expect(res.status).toBe(202);
    expect(await res.text()).toBe('');
    expect(funnel.calls).toEqual([
      { event: 'share_clicked', sessionRef: 'sid-share-1', profileId: P1, requester: null },
    ]);
  });

  it('非法 event / 伪造服务端三类事件 / 非 uuid profileId → 400，不落事件', async () => {
    const { app, funnel } = await setup();
    for (const body of [
      { event: 'bogus' },
      { event: 'analyze_enqueued' },
      { event: 'analyze_cache_hit' },
      { event: 'report_viewed', profileId: P1 },
      { event: 'share_clicked', profileId: 'not-a-uuid' },
      'not-an-object',
    ]) {
      const res = await post(app, body);
      expect(res.status).toBe(400);
    }
    expect(funnel.calls).toHaveLength(0);
  });

  it('同一可信 IP 超过 60 次/小时 → 429（第 61 次起）', async () => {
    const { app, funnel } = await setup();
    for (let i = 0; i < 60; i += 1) {
      const res = await post(app, { event: 'share_clicked', profileId: P1 });
      expect(res.status).toBe(202);
    }
    const limited = await post(app, { event: 'share_clicked', profileId: P1 });
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ retryAfterSeconds: 3600 });
    expect(funnel.calls).toHaveLength(60);
  });

  it('fail-open：仓储抛错仍 202（埋点绝不暴露内部失败给前端）', async () => {
    const broken: IFunnelEventsRepository = {
      async insert() {
        throw new Error('no such table: funnel_events');
      },
      async recordView() {
        return 'inserted';
      },
      async summarize() {
        return [];
      },
      async summarizeDaily() {
        return [];
      },
    };
    const repos = await createStorage({ sqlitePath: ':memory:' });
    const app = await createApp({
      repos,
      now: () => NOW,
      demoConfig: makeConfig(),
      funnelRecorder: createFunnelRecorder(broken),
    });
    const res = await post(app, { event: 'share_clicked', profileId: P1 });
    expect(res.status).toBe(202);
  });
});
