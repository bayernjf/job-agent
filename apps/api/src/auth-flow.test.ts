/**
 * 账号/OAuth 主脊集成测试（决策 #1-A/#6-A，2026-09-18）：
 * - GET /auth/github/login 未配置 501；配置后 302 + 签名 state Cookie
 * - GET /auth/github/callback：state 校验、交换失败 502、happy path 建账号/会话
 * - GET /auth/me：登录身份（不含 email/providerAccountId）
 * - POST /profiles/:id/claim：匿名 401、非本人 403、不存在 404、本人 200 且置 claimed
 * - POST /auth/logout：撤销会话
 * - POST /analyze：登录用户直接建 job（requesterKind=user，不占演示配额）
 *
 * 全部内存 SQLite + FakeAuthProvider（不打真实 GitHub/网络），Hono app.request。
 */
import { describe, expect, it } from 'vitest';
import type { AbilityProfile } from '@jobagent/shared';
import { createStorage, type StorageContext } from '@jobagent/storage';
import { createApp, type ApiDeps } from './index.js';
import { FakeAuthProvider } from './fake-auth.js';
import type { OAuthProfile } from './auth-provider.js';
import { loadAuthConfig } from './auth-config.js';

const ALICE: OAuthProfile = {
  platform: 'github',
  providerAccountId: '101',
  login: 'alice',
  name: 'Alice',
  email: 'alice@example.com',
  avatarUrl: 'https://example.com/a.png',
};

async function freshRepos(): Promise<StorageContext> {
  return createStorage({ sqlitePath: ':memory:' });
}

/** 汇总一次响应里所有 Set-Cookie 为 name→value（兼容多条 Set-Cookie）。 */
function extractCookies(res: Response): Record<string, string> {
  const out: Record<string, string> = {};
  const headers =
    typeof res.headers.getSetCookie === 'function'
      ? res.headers.getSetCookie()
      : [res.headers.get('set-cookie') ?? ''];
  for (const sc of headers) {
    const pair = sc.split(';')[0] ?? '';
    const eq = pair.indexOf('=');
    if (eq > 0) out[pair.slice(0, eq).trim()] = decodeURIComponent(pair.slice(eq + 1));
  }
  return out;
}

function cookieHeader(cookies: Record<string, string>, ...names: string[]): string {
  return names
    .filter((n) => cookies[n] !== undefined)
    .map((n) => `${n}=${cookies[n]}`)
    .join('; ');
}

function abilityProfile(profileId: string, login: string): AbilityProfile {
  return {
    profileId,
    analyzerVersion: 'schema-0.1-engine-0.1.0',
    generatedAt: '2026-09-01T00:00:00.000Z',
    dataWindow: { since: '2025-09-01T00:00:00.000Z', until: '2026-09-01T00:00:00.000Z' },
    analysisLayers: ['L0', 'L1'],
    subject: { platform: 'github', login, profileUrl: `https://github.com/${login}`, claimed: false },
    summary: { headline: 'Test developer' },
    skillTags: [],
    activity: { longevityMonths: 12 },
    collaboration: { evidenceRefs: [] },
    authenticity: { status: 'likely_authentic', confidence: 0.75, signals: [] },
    interviewQuestions: [],
    caveats: [],
  };
}

async function insertProfile(
  repos: StorageContext,
  id: string,
  login: string,
): Promise<void> {
  await repos.profiles.insert({
    id,
    analyzerVersion: 'schema-0.1-engine-0.1.0',
    subjectPlatform: 'github',
    subjectLogin: login,
    dataWindowSince: '2025-09-01T00:00:00.000Z',
    dataWindowUntil: '2026-09-01T00:00:00.000Z',
    status: 'complete',
    snapshot: abilityProfile(id, login),
  });
}

/** 走完整登录，返回带会话 Cookie 的 jar 与 repos。 */
async function loginAs(
  profile: OAuthProfile = ALICE,
  opts: { failure?: string } = {},
): Promise<{ repos: StorageContext; cookies: Record<string, string> }> {
  const repos = await freshRepos();
  const deps: ApiDeps = {
    repos,
    authConfig: loadAuthConfig({}),
    githubAuthProvider: new FakeAuthProvider(opts.failure ? null : profile, opts.failure),
  };
  const app = await createApp(deps);

  const loginRes = await app.request('/auth/github/login');
  expect(loginRes.status).toBe(302);
  const stateCookies = extractCookies(loginRes);
  const state = stateCookies.jobagent_oauth_state;
  expect(state).toBeTruthy();

  const callbackRes = await app.request(`/auth/github/callback?state=${encodeURIComponent(state!)}&code=fake-code`, {
    headers: { Cookie: cookieHeader(stateCookies, 'jobagent_oauth_state') },
  });
  expect(callbackRes.status).toBe(302);
  const sessionCookies = extractCookies(callbackRes);
  expect(sessionCookies.jobagent_session).toBeTruthy();

  // 会话 jar：浏览器此后只保留 session（state 已被清）
  return { repos, cookies: { jobagent_session: sessionCookies.jobagent_session! } };
}

describe('GitHub OAuth login', () => {
  it('returns 501 when no provider is configured', async () => {
    const app = await createApp({ repos: await freshRepos(), githubAuthProvider: null });
    const res = await app.request('/auth/github/login');
    expect(res.status).toBe(501);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('AUTH_NOT_CONFIGURED');
  });

  it('completes the happy path and exposes the logged-in identity without email', async () => {
    const { repos, cookies } = await loginAs();
    const app = await createApp({
      repos,
      authConfig: loadAuthConfig({}),
      githubAuthProvider: new FakeAuthProvider(ALICE),
    });

    const meRes = await app.request('/auth/me', {
      headers: { Cookie: cookieHeader(cookies, 'jobagent_session') },
    });
    expect(meRes.status).toBe(200);
    const me = (await meRes.json()) as Record<string, unknown>;
    expect(me.kind).toBe('user');
    expect(me.login).toBe('alice');
    expect(me.platform).toBe('github');
    expect(me.accountId).toBeTruthy();
    expect(me.expiresAt).toBeTruthy();
    // 刻意不外发敏感字段
    expect(me).not.toHaveProperty('email');
    expect(me).not.toHaveProperty('providerAccountId');

    // 账号确实落库且邮箱仅服务端留存
    const accounts = await repos.accounts.getByProvider('github', '101');
    expect(accounts?.login).toBe('alice');
    expect(accounts?.email).toBe('alice@example.com');
  });

  it('rejects a callback whose state cookie is missing or mismatched', async () => {
    const repos = await freshRepos();
    const app = await createApp({
      repos,
      authConfig: loadAuthConfig({}),
      githubAuthProvider: new FakeAuthProvider(ALICE),
    });
    const loginRes = await app.request('/auth/github/login');
    const state = extractCookies(loginRes).jobagent_oauth_state!;

    // query 与 cookie 不一致
    const mismatch = await app.request(
      `/auth/github/callback?state=${encodeURIComponent('tampered.value')}&code=fake-code`,
      { headers: { Cookie: `jobagent_oauth_state=${state}` } },
    );
    expect(mismatch.status).toBe(400);
    expect((await mismatch.json() as { code: string }).code).toBe('AUTH_INVALID_STATE');

    // 完全缺 state cookie
    const noCookie = await app.request(
      `/auth/github/callback?state=${encodeURIComponent(state)}&code=fake-code`,
    );
    expect(noCookie.status).toBe(400);
  });

  it('returns 502 when the upstream token/profile exchange fails', async () => {
    const repos = await freshRepos();
    const app = await createApp({
      repos,
      authConfig: loadAuthConfig({}),
      githubAuthProvider: new FakeAuthProvider(null, 'upstream down'),
    });
    const loginRes = await app.request('/auth/github/login');
    const state = extractCookies(loginRes).jobagent_oauth_state!;
    const cb = await app.request(
      `/auth/github/callback?state=${encodeURIComponent(state)}&code=fake-code`,
      { headers: { Cookie: `jobagent_oauth_state=${state}` } },
    );
    expect(cb.status).toBe(502);
    expect((await cb.json() as { code: string }).code).toBe('AUTH_EXCHANGE_FAILED');
  });
});

describe('POST /profiles/:id/claim', () => {
  it('requires authentication for anonymous callers', async () => {
    const repos = await freshRepos();
    await insertProfile(repos, 'prof-1', 'alice');
    const app = await createApp({ repos, githubAuthProvider: null });
    const res = await app.request('/profiles/prof-1/claim', { method: 'POST' });
    expect(res.status).toBe(401);
    expect((await res.json() as { code: string }).code).toBe('AUTH_REQUIRED');
  });

  it('claims the owner profile and marks it, but rejects non-owners and missing profiles', async () => {
    const { repos, cookies } = await loginAs();
    await insertProfile(repos, 'prof-alice', 'alice');
    await insertProfile(repos, 'prof-bob', 'bob');
    const app = await createApp({
      repos,
      authConfig: loadAuthConfig({}),
      githubAuthProvider: new FakeAuthProvider(ALICE),
    });
    const auth = { Cookie: cookieHeader(cookies, 'jobagent_session') };

    // 别人的画像 → 403
    const forbidden = await app.request('/profiles/prof-bob/claim', { method: 'POST', headers: auth });
    expect(forbidden.status).toBe(403);
    expect((await forbidden.json() as { code: string }).code).toBe('AUTH_NOT_PROFILE_OWNER');

    // 不存在 → 404
    const missing = await app.request('/profiles/nope/claim', { method: 'POST', headers: auth });
    expect(missing.status).toBe(404);
    expect((await missing.json() as { code: string }).code).toBe('AUTH_PROFILE_NOT_FOUND');

    // 本人 → 200
    const ok = await app.request('/profiles/prof-alice/claim', { method: 'POST', headers: auth });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as Record<string, unknown>;
    expect(body.claimed).toBe(true);
    expect(body.profileId).toBe('prof-alice');

    // 画像与账号双侧都记录了认领
    const profile = await repos.profiles.getById('prof-alice');
    expect(profile?.subjectClaimed).toBe(true);
    const account = await repos.accounts.getByProvider('github', '101');
    expect(account?.claimedProfileId).toBe('prof-alice');
  });
});

describe('POST /auth/logout', () => {
  it('revokes the session so /auth/me falls back to anonymous', async () => {
    const { repos, cookies } = await loginAs();
    const app = await createApp({
      repos,
      authConfig: loadAuthConfig({}),
      githubAuthProvider: new FakeAuthProvider(ALICE),
    });
    const logoutRes = await app.request('/auth/logout', {
      method: 'POST',
      headers: { Cookie: cookieHeader(cookies, 'jobagent_session') },
    });
    expect(logoutRes.status).toBe(200);

    // 旧 token 已撤销，再用它解析应为匿名
    const meRes = await app.request('/auth/me', {
      headers: { Cookie: cookieHeader(cookies, 'jobagent_session') },
    });
    expect((await meRes.json() as { kind: string }).kind).toBe('anonymous');
  });
});

describe('POST /analyze for logged-in users', () => {
  it('creates a user job without consuming demo quota', async () => {
    const { repos, cookies } = await loginAs();
    const app = await createApp({
      repos,
      authConfig: loadAuthConfig({}),
      githubAuthProvider: new FakeAuthProvider(ALICE),
    });
    const res = await app.request('/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookieHeader(cookies, 'jobagent_session') },
      body: JSON.stringify({ username: 'alice' }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { jobId: string };
    const job = await repos.jobs.getById(body.jobId);
    expect(job?.requesterKind).toBe('user');
    expect(job?.demoSessionId).toBeNull();
  });
});

describe('OAuth return_to deep link', () => {
  async function makeApp(repos: StorageContext) {
    return createApp({
      repos,
      authConfig: loadAuthConfig({}),
      githubAuthProvider: new FakeAuthProvider(ALICE),
    });
  }

  type App = Awaited<ReturnType<typeof makeApp>>;

  async function startLogin(app: App, returnTo?: string) {
    const url =
      '/auth/github/login' + (returnTo ? `?return_to=${encodeURIComponent(returnTo)}` : '');
    const res = await app.request(url);
    expect(res.status).toBe(302);
    return extractCookies(res);
  }

  async function finishCallback(
    app: App,
    cookies: Record<string, string>,
  ): Promise<Response> {
    return app.request(
      `/auth/github/callback?state=${encodeURIComponent(cookies.jobagent_oauth_state!)}&code=fake-code`,
      {
        headers: {
          Cookie: cookieHeader(cookies, 'jobagent_oauth_state', 'jobagent_oauth_return'),
        },
      },
    );
  }

  function setCookies(res: Response): string[] {
    return typeof res.headers.getSetCookie === 'function'
      ? res.headers.getSetCookie()
      : [res.headers.get('set-cookie') ?? ''];
  }

  it('stores a same-origin return_to and redirects back to it, clearing the cookie', async () => {
    const app = await makeApp(await freshRepos());
    const cookies = await startLogin(app, '/zh-CN/report/prof_1?view=recruiter');
    expect(cookies.jobagent_oauth_return).toBe('/zh-CN/report/prof_1?view=recruiter');

    const cb = await finishCallback(app, cookies);
    expect(cb.status).toBe(302);
    expect(cb.headers.get('location')).toBe('/zh-CN/report/prof_1?view=recruiter');

    // 回跳 Cookie 必须被即时删除（Max-Age=0 / 过期 Expires）
    const cleared = setCookies(cb).find((sc) => sc.startsWith('jobagent_oauth_return='));
    expect(cleared).toBeTruthy();
    expect(cleared).toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/i);
  });

  it('drops an unsafe protocol-relative return_to and falls back to the default URL', async () => {
    const app = await makeApp(await freshRepos());
    const cookies = await startLogin(app, '//evil.com/phish');
    expect(cookies.jobagent_oauth_return).toBeUndefined();

    const cb = await finishCallback(app, cookies);
    expect(cb.status).toBe(302);
    expect(cb.headers.get('location')).toBe('/');
  });

  it('falls back to the default landing URL when no return_to is provided', async () => {
    const app = await makeApp(await freshRepos());
    const cookies = await startLogin(app);
    const cb = await finishCallback(app, cookies);
    expect(cb.status).toBe(302);
    expect(cb.headers.get('location')).toBe('/');
  });
});
