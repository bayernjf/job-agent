/**
 * DELETE /profiles/:id 集成测试（B2 自助解绑，2026-09-27，兑现 PRD:230「可解绑」）：
 * - 未登录 → 401
 * - 登录但画像未认领 → 403（必须先认领才能自助删除）
 * - 登录删不存在 → 404
 * - 登录删他人已认领画像 → 403（平台登录名不一致）
 * - 登录本人删已认领画像 → 200，级联：evidence/applications/interviews 清空、
 *   accounts.claimed_profile_id 置空、画像行消失、分享 GET /profiles/:id → 404
 * - 融合画像（subjectPlatform='all'）本人删除 → 200（覆盖 all 分支）
 *
 * 全部内存 SQLite + FakeAuthProvider（不打网络），Hono app.request()。
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

const BOB: OAuthProfile = {
  platform: 'github',
  providerAccountId: '202',
  login: 'bob',
  name: 'Bob',
  email: 'bob@example.com',
  avatarUrl: 'https://example.com/b.png',
};

async function freshRepos(): Promise<StorageContext> {
  return createStorage({ sqlitePath: ':memory:' });
}

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
    .map((n) => `${n}=${encodeURIComponent(cookies[n]!)}`)
    .join('; ');
}

/** 走完整 GitHub OAuth 登录，返回带 session Cookie 的 jar 与 repos。 */
async function loginAs(
  profile: OAuthProfile = ALICE,
): Promise<{ repos: StorageContext; cookies: Record<string, string> }> {
  const repos = await freshRepos();
  const deps: ApiDeps = {
    repos,
    authConfig: loadAuthConfig({}),
    githubAuthProvider: new FakeAuthProvider(profile),
  };
  const app = await createApp(deps);

  const loginRes = await app.request('/auth/github/login');
  expect(loginRes.status).toBe(302);
  const stateCookies = extractCookies(loginRes);
  const state = stateCookies.jobagent_oauth_state;
  expect(state).toBeTruthy();

  const callbackRes = await app.request(
    `/auth/github/callback?state=${encodeURIComponent(state!)}&code=fake-code`,
    { headers: { Cookie: cookieHeader(stateCookies, 'jobagent_oauth_state') } },
  );
  expect(callbackRes.status).toBe(302);
  const sessionCookies = extractCookies(callbackRes);
  expect(sessionCookies.jobagent_session).toBeTruthy();
  return { repos, cookies: { jobagent_session: sessionCookies.jobagent_session! } };
}

function abilityProfile(profileId: string, login: string, platform: 'github' | 'gitee' = 'github'): AbilityProfile {
  return {
    profileId,
    analyzerVersion: 'schema-0.1-engine-0.1.0',
    generatedAt: '2026-09-01T00:00:00.000Z',
    dataWindow: { since: '2025-09-01T00:00:00.000Z', until: '2026-09-01T00:00:00.000Z' },
    analysisLayers: ['L0', 'L1'],
    subject: {
      platform,
      login,
      profileUrl: `https://github.com/${login}`,
      claimed: false,
    },
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
  platform: 'github' | 'gitee' | 'all' = 'github',
): Promise<void> {
  await repos.profiles.insert({
    id,
    analyzerVersion: 'schema-0.1-engine-0.1.0',
    subjectPlatform: platform,
    subjectLogin: login,
    dataWindowSince: '2025-09-01T00:00:00.000Z',
    dataWindowUntil: '2026-09-01T00:00:00.000Z',
    status: 'complete',
    // AbilityProfile.subject.platform 是单源（融合标记 'all' 只在 storage 行级 subjectPlatform）
    snapshot: abilityProfile(id, login, platform === 'all' ? 'github' : platform),
  });
}

/** 造已认领画像（markClaimed + 账号记录认领），并挂关联数据：证据/投递/面试各一条。 */
async function seedClaimedProfileWithData(
  repos: StorageContext,
  profileId: string,
  accountId: string,
  login: string,
  platform: 'github' | 'gitee' | 'all' = 'github',
): Promise<void> {
  await insertProfile(repos, profileId, login, platform);
  await repos.profiles.markClaimed(profileId);
  await repos.accounts.setClaimedProfile(accountId, profileId);
  await repos.evidence.insert({
    id: `ev-${profileId}`,
    profileId,
    sourcePlatform: platform === 'all' ? 'github' : platform,
    sourceType: 'commit',
    url: `https://example.com/${login}/commit/abc`,
    occurredAt: '2026-08-01T00:00:00.000Z',
    layer: 'L1',
    claim: 'committed',
    rawRef: 'raw-1',
  });
  await repos.applications.insert({
    id: `app-${profileId}`,
    profileId,
    targetTitle: 'Backend Engineer',
    targetCompany: 'Acme',
    status: 'applied',
    appliedAt: '2026-09-01T00:00:00.000Z',
    createdByAccountId: accountId,
  });
  await repos.interviews.insert({
    id: `iv-${profileId}`,
    profileId,
    targetTitle: 'Backend Engineer',
    targetCompany: 'Acme',
    scheduledStart: '2026-09-10T10:00:00.000Z',
    scheduledEnd: '2026-09-10T11:00:00.000Z',
    format: 'video',
    roundLabel: 'Round 1',
    status: 'scheduled',
    createdByAccountId: accountId,
  });
}

describe('DELETE /profiles/:id — B2 自助解绑', () => {
  it('rejects unauthenticated deletion with 401 even for a claimed profile', async () => {
    const repos = await freshRepos();
    await insertProfile(repos, 'prof-1', 'alice');
    await repos.profiles.markClaimed('prof-1');
    const app = await createApp({ repos });

    const res = await app.request('/profiles/prof-1', { method: 'DELETE' });
    expect(res.status).toBe(401);
    // 删除必须没有任何副作用
    expect(await repos.profiles.getById('prof-1')).toBeTruthy();
  });

  it('rejects deletion of an unclaimed profile with 403 (must claim first)', async () => {
    const { repos, cookies } = await loginAs(ALICE);
    await insertProfile(repos, 'prof-unclaimed', 'alice');
    const app = await createApp({ repos });

    const res = await app.request('/profiles/prof-unclaimed', {
      method: 'DELETE',
      headers: { Cookie: cookieHeader(cookies, 'jobagent_session') },
    });
    expect(res.status).toBe(403);
    expect(await repos.profiles.getById('prof-unclaimed')).toBeTruthy();
  });

  it('returns 404 for a missing profile', async () => {
    const { repos, cookies } = await loginAs(ALICE);
    const app = await createApp({ repos });

    const res = await app.request('/profiles/prof-missing', {
      method: 'DELETE',
      headers: { Cookie: cookieHeader(cookies, 'jobagent_session') },
    });
    expect(res.status).toBe(404);
  });

  it('rejects deletion of another user claimed profile with 403', async () => {
    const { repos, cookies } = await loginAs(BOB); // Bob 登录
    await insertProfile(repos, 'prof-alice', 'alice');
    await repos.profiles.markClaimed('prof-alice');
    // Alice 的账号认领自己的画像（直接仓储造态）
    await repos.accounts.setClaimedProfile('bob-account-placeholder', 'prof-alice');
    const app = await createApp({ repos });

    // Bob 与画像 subject 不一致 → 403
    const res = await app.request('/profiles/prof-alice', {
      method: 'DELETE',
      headers: { Cookie: cookieHeader(cookies, 'jobagent_session') },
    });
    expect(res.status).toBe(403);
    expect(await repos.profiles.getById('prof-alice')).toBeTruthy();
  });

  it('deletes own claimed profile with full cascade', async () => {
    const { repos, cookies } = await loginAs(ALICE);
    const account = await repos.accounts.getByProvider('github', ALICE.providerAccountId);
    expect(account).toBeTruthy();
    await seedClaimedProfileWithData(repos, 'prof-mine', account!.id, 'alice');

    const app = await createApp({ repos });
    const res = await app.request('/profiles/prof-mine', {
      method: 'DELETE',
      headers: { Cookie: cookieHeader(cookies, 'jobagent_session') },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { deleted: boolean; profileId: string };
    expect(body.deleted).toBe(true);
    expect(body.profileId).toBe('prof-mine');

    // 级联验证：主表行消失
    expect(await repos.profiles.getById('prof-mine')).toBeUndefined();
    // 证据清空
    expect(await repos.evidence.listByProfile('prof-mine')).toHaveLength(0);
    // 投递清空
    expect(await repos.applications.listByProfile('prof-mine')).toHaveLength(0);
    // 面试清空（按创建账号查）
    expect(await repos.interviews.listByOwner(account!.id)).toHaveLength(0);
    // 认领撤销：账号不再指向该画像
    const after = await repos.accounts.getById(account!.id);
    expect(after?.claimedProfileId).toBeNull();
    // 分享链失效
    const share = await app.request('/profiles/prof-mine');
    expect(share.status).toBe(404);
    // 账号本身保留（仍可登录）
    expect(after).toBeTruthy();
  });

  it('allows deleting a fused (platform=all) claimed profile by either-source login', async () => {
    const { repos, cookies } = await loginAs(ALICE);
    const account = await repos.accounts.getByProvider('github', ALICE.providerAccountId);
    expect(account).toBeTruthy();
    await seedClaimedProfileWithData(repos, 'prof-fused', account!.id, 'alice', 'all');

    const app = await createApp({ repos });
    const res = await app.request('/profiles/prof-fused', {
      method: 'DELETE',
      headers: { Cookie: cookieHeader(cookies, 'jobagent_session') },
    });
    expect(res.status).toBe(200);
    expect(await repos.profiles.getById('prof-fused')).toBeUndefined();
    expect((await repos.accounts.getById(account!.id))?.claimedProfileId).toBeNull();
  });
});
