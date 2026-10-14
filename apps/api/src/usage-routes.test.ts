/**
 * 用量计量读侧路由测试（决策 #25 ④ 成本回采 Wave D，design-cost-metering-20261014 §7）。
 * 内存 SQLite + FakeAuthProvider 完整登录，全程不打网络：
 * - 匿名：两端点 401 AUTH_REQUIRED；非 admin：/admin/usage 403 FORBIDDEN
 * - 本人面：只看自己（query 塞别人的 accountId 也被强制改写）、响应不回显 accountId
 * - admin 面：全平台聚合、按 accountId 过滤并回显、category 过滤
 * - 非法 query（缺 sinceIso / category 非法 / 时间串不可解析）→ 400
 * - 窗口护栏：sinceIso 早于 180 天上限 → 400
 * - 空窗口 → 200 空数组；出参逐行过 shared Zod 形状
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { UsageDailyRowSchema, UsageSummaryRowSchema } from '@jobagent/shared';
import { createStorage, type StorageContext } from '@jobagent/storage';
import { createApp, type ApiDeps } from './index.js';
import { FakeAuthProvider } from './fake-auth.js';
import type { OAuthProfile } from './auth-provider.js';
import { loadAuthConfig } from './auth-config.js';

const ADMIN: OAuthProfile = {
  platform: 'github',
  providerAccountId: '301',
  login: 'usage-admin',
  name: 'Usage Admin',
  email: 'usage-admin@example.com',
  avatarUrl: 'https://example.com/usage-admin.png',
};
const BOB: OAuthProfile = {
  platform: 'github',
  providerAccountId: '302',
  login: 'usage-bob',
  name: 'Usage Bob',
  email: 'usage-bob@example.com',
  avatarUrl: 'https://example.com/usage-bob.png',
};

/** 固定"现在"，窗口护栏判定确定：180 天前 = 2026-04-17T00:00:00.000Z。 */
const NOW = '2026-10-14T00:00:00.000Z';
const SINCE_OK = '2026-10-01T00:00:00.000Z';
const SINCE_TOO_OLD = '2026-01-01T00:00:00.000Z';

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

async function loginAs(
  profile: OAuthProfile,
  app: Awaited<ReturnType<typeof createApp>>,
): Promise<Record<string, string>> {
  const loginRes = await app.request('/auth/github/login');
  const stateCookies = extractCookies(loginRes);
  const state = stateCookies.jobagent_oauth_state!;
  const callbackRes = await app.request(
    `/auth/github/callback?state=${encodeURIComponent(state)}&code=fake-code`,
    { headers: { Cookie: cookieHeader(stateCookies, 'jobagent_oauth_state') } },
  );
  const sessionCookies = extractCookies(callbackRes);
  return { jobagent_session: sessionCookies.jobagent_session! };
}

async function accountIdOf(
  app: Awaited<ReturnType<typeof createApp>>,
  cookies: Record<string, string>,
): Promise<string> {
  const me = await app.request('/auth/me', {
    headers: { Cookie: cookieHeader(cookies, 'jobagent_session') },
  });
  return ((await me.json()) as { accountId: string }).accountId;
}

async function setup(profile: OAuthProfile) {
  const repos = await createStorage({ sqlitePath: ':memory:' });
  const deps: ApiDeps = {
    repos,
    authConfig: loadAuthConfig({}),
    githubAuthProvider: new FakeAuthProvider(profile),
    now: () => NOW,
  };
  const app = await createApp(deps);
  return { repos, app };
}

/** 造三个账号维度的事件：本人 llm / 别人 search / 平台级（null）analysis。 */
async function seedEvents(repos: StorageContext, bobAccountId: string): Promise<void> {
  await repos.usageEvents.insert({
    id: 'usg-b1',
    accountId: bobAccountId,
    category: 'llm',
    feature: 'cover_letter',
    billingSource: 'builtin',
    provider: 'agnes',
    model: 'agnes-3.0-flash',
    promptTokens: 100,
    completionTokens: 50,
    quantity: null,
    createdAt: '2026-10-10T12:00:00.000Z',
  });
  await repos.usageEvents.insert({
    id: 'usg-o1',
    accountId: 'acct-other',
    category: 'search',
    feature: 'websearch',
    billingSource: 'platform',
    provider: 'tavily',
    model: null,
    promptTokens: null,
    completionTokens: null,
    quantity: 3,
    createdAt: '2026-10-11T00:00:00.000Z',
  });
  await repos.usageEvents.insert({
    id: 'usg-n1',
    accountId: null,
    category: 'analysis',
    feature: 'analysis_job',
    billingSource: 'platform',
    provider: 'github',
    model: null,
    promptTokens: null,
    completionTokens: null,
    quantity: 2,
    createdAt: '2026-10-11T06:00:00.000Z',
  });
}

describe('GET /account/usage（本人面）', () => {
  it('匿名 → 401 AUTH_REQUIRED', async () => {
    const { app } = await setup(BOB);
    const res = await app.request(`/account/usage?sinceIso=${SINCE_OK}`);
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: 'AUTH_REQUIRED' });
  });

  it('登录用户只看自己：query 塞别人的 accountId 也被强制改写，且响应不回显 accountId', async () => {
    const { repos, app } = await setup(BOB);
    const cookies = await loginAs(BOB, app);
    const bobId = await accountIdOf(app, cookies);
    await seedEvents(repos, bobId);
    const auth = { Cookie: cookieHeader(cookies, 'jobagent_session') };

    const res = await app.request(
      `/account/usage?sinceIso=${SINCE_OK}&accountId=acct-other`,
      { headers: auth },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { summary: unknown[]; daily: unknown[]; accountId?: string };
    expect(body).not.toHaveProperty('accountId');
    // 出参逐行过 shared Zod 形状
    expect(z.array(UsageSummaryRowSchema).safeParse(body.summary).success).toBe(true);
    expect(z.array(UsageDailyRowSchema).safeParse(body.daily).success).toBe(true);

    expect(body.summary).toHaveLength(1);
    expect(body.summary[0]).toMatchObject({
      category: 'llm',
      feature: 'cover_letter',
      billingSource: 'builtin',
      events: 1,
      sumPromptTokens: 100,
      sumCompletionTokens: 50,
      sumQuantity: 0,
    });
    expect(body.daily).toHaveLength(1);
    expect(body.daily[0]).toMatchObject({ day: '2026-10-10', category: 'llm', events: 1 });
  });

  it('空窗口 → 200，两个数组都为空', async () => {
    const { repos, app } = await setup(BOB);
    const cookies = await loginAs(BOB, app);
    const bobId = await accountIdOf(app, cookies);
    await seedEvents(repos, bobId);
    const auth = { Cookie: cookieHeader(cookies, 'jobagent_session') };

    const res = await app.request(`/account/usage?sinceIso=2026-10-13T00:00:00.000Z`, {
      headers: auth,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ summary: [], daily: [] });
  });

  it('缺 sinceIso → 400 validation failed；category 非法 → 400', async () => {
    const { app } = await setup(BOB);
    const cookies = await loginAs(BOB, app);
    const auth = { Cookie: cookieHeader(cookies, 'jobagent_session') };

    const missing = await app.request('/account/usage', { headers: auth });
    expect(missing.status).toBe(400);
    expect(await missing.json()).toMatchObject({ error: 'validation failed' });

    const badCategory = await app.request(
      `/account/usage?sinceIso=${SINCE_OK}&category=bogus`,
      { headers: auth },
    );
    expect(badCategory.status).toBe(400);
    expect(await badCategory.json()).toMatchObject({ error: 'validation failed' });
  });

  it('sinceIso 不可解析 → 400 BAD_REQUEST；超过 180 天窗口 → 400 BAD_REQUEST', async () => {
    const { app } = await setup(BOB);
    const cookies = await loginAs(BOB, app);
    const auth = { Cookie: cookieHeader(cookies, 'jobagent_session') };

    const garbage = await app.request(`/account/usage?sinceIso=not-a-date`, { headers: auth });
    expect(garbage.status).toBe(400);
    expect(await garbage.json()).toMatchObject({ code: 'BAD_REQUEST' });

    const tooOld = await app.request(`/account/usage?sinceIso=${SINCE_TOO_OLD}`, {
      headers: auth,
    });
    expect(tooOld.status).toBe(400);
    expect(await tooOld.json()).toMatchObject({ code: 'BAD_REQUEST' });
  });
});

describe('GET /admin/usage（admin 面）', () => {
  it('匿名 → 401 AUTH_REQUIRED', async () => {
    const { app } = await setup(ADMIN);
    const res = await app.request(`/admin/usage?sinceIso=${SINCE_OK}`);
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: 'AUTH_REQUIRED' });
  });

  it('登录但非 admin → 403 FORBIDDEN', async () => {
    const { app } = await setup(BOB);
    const cookies = await loginAs(BOB, app);
    const res = await app.request(`/admin/usage?sinceIso=${SINCE_OK}`, {
      headers: { Cookie: cookieHeader(cookies, 'jobagent_session') },
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'FORBIDDEN' });
  });

  it('admin 看全平台；按 accountId 过滤时回显过滤条件；category 过滤生效', async () => {
    const { repos, app } = await setup(ADMIN);
    const cookies = await loginAs(ADMIN, app);
    const adminId = await accountIdOf(app, cookies);
    await repos.accounts.setAdmin(adminId, true);
    await seedEvents(repos, 'acct-bob');
    const auth = { Cookie: cookieHeader(cookies, 'jobagent_session') };

    // 全平台：三个分组都到
    const all = await app.request(`/admin/usage?sinceIso=${SINCE_OK}`, { headers: auth });
    expect(all.status).toBe(200);
    const allBody = (await all.json()) as { summary: unknown[]; daily: unknown[] };
    expect(z.array(UsageSummaryRowSchema).safeParse(allBody.summary).success).toBe(true);
    expect(allBody.summary).toHaveLength(3);

    // accountId 过滤：只剩 websearch 那行，并回显过滤条件
    const filtered = await app.request(
      `/admin/usage?sinceIso=${SINCE_OK}&accountId=acct-other`,
      { headers: auth },
    );
    expect(filtered.status).toBe(200);
    const filteredBody = (await filtered.json()) as {
      summary: Array<Record<string, unknown>>;
      accountId?: string;
    };
    expect(filteredBody.accountId).toBe('acct-other');
    expect(filteredBody.summary).toHaveLength(1);
    expect(filteredBody.summary[0]).toMatchObject({
      category: 'search',
      feature: 'websearch',
      sumQuantity: 3,
    });

    // category 过滤：只剩平台级 analysis（accountId=null 也计入全平台口径）
    const byCategory = await app.request(
      `/admin/usage?sinceIso=${SINCE_OK}&category=analysis`,
      { headers: auth },
    );
    expect(byCategory.status).toBe(200);
    const categoryBody = (await byCategory.json()) as {
      summary: Array<Record<string, unknown>>;
      accountId?: string;
    };
    expect(categoryBody).not.toHaveProperty('accountId');
    expect(categoryBody.summary).toHaveLength(1);
    expect(categoryBody.summary[0]).toMatchObject({
      category: 'analysis',
      feature: 'analysis_job',
      billingSource: 'platform',
      sumQuantity: 2,
    });
  });

  it('超窗同样 400', async () => {
    const { repos, app } = await setup(ADMIN);
    const cookies = await loginAs(ADMIN, app);
    const adminId = await accountIdOf(app, cookies);
    await repos.accounts.setAdmin(adminId, true);
    const res = await app.request(`/admin/usage?sinceIso=${SINCE_TOO_OLD}`, {
      headers: { Cookie: cookieHeader(cookies, 'jobagent_session') },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'BAD_REQUEST' });
  });
});
