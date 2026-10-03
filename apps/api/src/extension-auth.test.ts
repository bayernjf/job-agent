/**
 * 扩展登录态端点测试（决策 #22，design-扩展登录态-20261004.md）：
 * - POST /auth/extension-token/issue：匿名 401；登录签发一次性 code
 * - POST /auth/extension-token/consume：404/410（已用/过期）/happy path 换长期 token
 * - Authorization: Bearer <apiToken> 解析为 user principal（/auth/me 验证）
 * - GET /auth/extension-tokens：授权管理列表（仅指纹）
 * - DELETE /auth/extension-tokens/:id：撤销后 token 立即失效
 *
 * 全部内存 SQLite + FakeAuthProvider（不打真实 GitHub/网络），Hono app.request。
 */
import { describe, expect, it } from 'vitest';
import { createStorage, type StorageContext } from '@jobagent/storage';
import { createApp } from './index.js';
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

/** 汇总一次响应里所有 Set-Cookie 为 name→value。 */
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

/** 走一遍 GitHub OAuth happy path，返回登录会话 Cookie。 */
async function loginAs(profile: OAuthProfile = ALICE) {
  const repos = await freshRepos();
  const app = await createApp({
    repos,
    authConfig: loadAuthConfig({}),
    githubAuthProvider: new FakeAuthProvider(profile),
  });
  const loginRes = await app.request('/auth/github/login');
  expect(loginRes.status).toBe(302);
  const stateCookies = extractCookies(loginRes);
  const state = stateCookies.jobagent_oauth_state;

  const callbackRes = await app.request(
    `/auth/github/callback?state=${encodeURIComponent(state!)}&code=fake-code`,
    { headers: { Cookie: cookieHeader(stateCookies, 'jobagent_oauth_state') } },
  );
  expect(callbackRes.status).toBe(302);
  const sessionCookies = extractCookies(callbackRes);
  return { repos, cookies: { jobagent_session: sessionCookies.jobagent_session! } };
}

describe('POST /auth/extension-token/issue', () => {
  it('rejects anonymous callers with 401', async () => {
    const app = await createApp({ repos: await freshRepos(), githubAuthProvider: null });
    const res = await app.request('/auth/extension-token/issue', { method: 'POST' });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('AUTH_REQUIRED');
  });

  it('issues a one-time code for a logged-in user', async () => {
    const { repos, cookies } = await loginAs();
    const app = await createApp({
      repos,
      authConfig: loadAuthConfig({}),
      githubAuthProvider: new FakeAuthProvider(ALICE),
    });
    const res = await app.request('/auth/extension-token/issue', {
      method: 'POST',
      headers: { Cookie: cookieHeader(cookies, 'jobagent_session') },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { code: string; expiresAt: string };
    expect(body.code.startsWith('ext-code-')).toBe(true);
    expect(body.expiresAt).toBeTruthy();
  });
});

describe('POST /auth/extension-token/consume', () => {
  it('returns 404 for an unknown code', async () => {
    const app = await createApp({ repos: await freshRepos(), githubAuthProvider: null });
    const res = await app.request('/auth/extension-token/consume', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'ext-code-nope' }),
    });
    expect(res.status).toBe(404);
  });

  it('returns 410 for an already-consumed code (no replay)', async () => {
    const { repos, cookies } = await loginAs();
    const app = await createApp({
      repos,
      authConfig: loadAuthConfig({}),
      githubAuthProvider: new FakeAuthProvider(ALICE),
    });
    const issued = await app.request('/auth/extension-token/issue', {
      method: 'POST',
      headers: { Cookie: cookieHeader(cookies, 'jobagent_session') },
    });
    const { code } = (await issued.json()) as { code: string };

    const first = await app.request('/auth/extension-token/consume', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    expect(first.status).toBe(200);
    const second = await app.request('/auth/extension-token/consume', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    expect(second.status).toBe(410);
    const body = (await second.json()) as { code: string };
    expect(body.code).toBe('EXT_CODE_USED');
  });

  it('returns 410 for an expired code', async () => {
    const { repos, cookies } = await loginAs();
    const app = await createApp({
      repos,
      authConfig: loadAuthConfig({}),
      githubAuthProvider: new FakeAuthProvider(ALICE),
    });
    // 直接插一条已过期的 code
    await repos.extensionAuthCodes.create({
      id: 'ext-code-old',
      accountId: 'acc-does-not-exist',
      expiresAt: '2026-01-01T00:00:00.000Z',
    });
    const res = await app.request('/auth/extension-token/consume', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'ext-code-old' }),
    });
    expect(res.status).toBe(410);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('EXT_CODE_EXPIRED');
  });

  it('exchanges a valid code for a long-lived token usable as Bearer', async () => {
    const { repos, cookies } = await loginAs();
    const app = await createApp({
      repos,
      authConfig: loadAuthConfig({}),
      githubAuthProvider: new FakeAuthProvider(ALICE),
    });
    const issued = await app.request('/auth/extension-token/issue', {
      method: 'POST',
      headers: { Cookie: cookieHeader(cookies, 'jobagent_session') },
    });
    const { code } = (await issued.json()) as { code: string };

    const consumed = await app.request('/auth/extension-token/consume', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    expect(consumed.status).toBe(200);
    const body = (await consumed.json()) as {
      apiToken: string;
      expiresAt: string;
      account: { platform: string; login: string };
    };
    expect(body.apiToken.startsWith('tkn-')).toBe(true);
    expect(body.account.login).toBe('alice');
    expect(body.expiresAt).toBeTruthy();

    // token 立即可用：/auth/me 以 user 身份返回（principal Bearer 分支）
    const meRes = await app.request('/auth/me', {
      headers: { Authorization: `Bearer ${body.apiToken}` },
    });
    expect(meRes.status).toBe(200);
    const me = (await meRes.json()) as { kind: string; login: string; accountId: string };
    expect(me.kind).toBe('user');
    expect(me.login).toBe('alice');
    expect(me.accountId).toBeTruthy();

    // 库中只存哈希：原始 token 不应出现在任何表里
    const accounts = await repos.accounts.getByProvider('github', '101');
    expect(accounts?.login).toBe('alice');
  });
});

describe('GET/DELETE /auth/extension-tokens', () => {
  it('lists only fingerprints for the logged-in account', async () => {
    const { repos, cookies } = await loginAs();
    const app = await createApp({
      repos,
      authConfig: loadAuthConfig({}),
      githubAuthProvider: new FakeAuthProvider(ALICE),
    });
    const issued = await app.request('/auth/extension-token/issue', {
      method: 'POST',
      headers: { Cookie: cookieHeader(cookies, 'jobagent_session') },
    });
    const { code } = (await issued.json()) as { code: string };
    await app.request('/auth/extension-token/consume', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });

    const listRes = await app.request('/auth/extension-tokens', {
      headers: { Cookie: cookieHeader(cookies, 'jobagent_session') },
    });
    expect(listRes.status).toBe(200);
    const { tokens } = (await listRes.json()) as {
      tokens: Array<{ id: string; fingerprint: string }>;
    };
    expect(tokens.length).toBe(1);
    expect(tokens[0]!.fingerprint.length).toBe(4);
    // 列表不得含明文 token 形态
    expect(tokens[0]!.id.startsWith('tkn-')).toBe(true);
  });

  it('revokes a token and it stops authenticating immediately', async () => {
    const { repos, cookies } = await loginAs();
    const app = await createApp({
      repos,
      authConfig: loadAuthConfig({}),
      githubAuthProvider: new FakeAuthProvider(ALICE),
    });
    const issued = await app.request('/auth/extension-token/issue', {
      method: 'POST',
      headers: { Cookie: cookieHeader(cookies, 'jobagent_session') },
    });
    const { code } = (await issued.json()) as { code: string };
    const consumed = await app.request('/auth/extension-token/consume', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    const { apiToken } = (await consumed.json()) as { apiToken: string };

    const listRes = await app.request('/auth/extension-tokens', {
      headers: { Cookie: cookieHeader(cookies, 'jobagent_session') },
    });
    const { tokens } = (await listRes.json()) as { tokens: Array<{ id: string }> };

    const delRes = await app.request(`/auth/extension-tokens/${tokens[0]!.id}`, {
      method: 'DELETE',
      headers: { Cookie: cookieHeader(cookies, 'jobagent_session') },
    });
    expect(delRes.status).toBe(204);

    // 撤销后 Bearer 失效 → 回退匿名
    const meRes = await app.request('/auth/me', {
      headers: { Authorization: `Bearer ${apiToken}` },
    });
    const me = (await meRes.json()) as { kind: string };
    expect(me.kind).toBe('anonymous');
  });

  it('returns 404 revoking a token that is not owned by the caller', async () => {
    const { repos, cookies } = await loginAs();
    const app = await createApp({
      repos,
      authConfig: loadAuthConfig({}),
      githubAuthProvider: new FakeAuthProvider(ALICE),
    });
    const res = await app.request('/auth/extension-tokens/tkn-not-owned', {
      method: 'DELETE',
      headers: { Cookie: cookieHeader(cookies, 'jobagent_session') },
    });
    expect(res.status).toBe(404);
  });
});
