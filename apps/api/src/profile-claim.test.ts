/**
 * 画像认领/删除的归属安全测试（评审 P1-1：融合画像跨平台冒名认领 + 级联删除）。
 *
 * 攻击路径（修复前）：受害者 GitHub login X 有融合画像（subjectPlatform='all'）
 * → 攻击者持 Gitee 同名 login X 登录 → POST /profiles/:id/claim 只比对 login 放行
 * → DELETE /profiles/:id 级联删除受害者全部数据（evidence/applications/interviews）。
 *
 * 修复后口径（principalOwnsProfile 单一事实源）：
 * - 单源画像：platform + login 双一致；
 * - 融合画像：只认主源 GitHub 的同名已验证账号；
 * - 已被认领的画像再认领 → 409（账号重建场景）并指向申诉通道；
 * - 删除前落 profile_events 审计事件（操作者 + 级联计数）。
 *
 * 全部内存 SQLite + FakeAuthProvider 走真实路由与数据库，不 mock 内部判定。
 */
import { describe, expect, it } from 'vitest';
import type { AbilityProfile } from '@jobagent/shared';
import { createStorage, type StorageContext } from '@jobagent/storage';
import { createApp, type ApiDeps } from './index.js';
import { FakeAuthProvider } from './fake-auth.js';
import type { OAuthProfile } from './auth-provider.js';
import { loadAuthConfig } from './auth-config.js';

const GH_ALICE: OAuthProfile = {
  platform: 'github',
  providerAccountId: '101',
  login: 'alice',
  name: 'Alice',
  email: 'alice@example.com',
  avatarUrl: null,
};

// 同 login、不同 providerAccountId：模拟"账号删除后重建"的新账号
const GH_ALICE_NEW: OAuthProfile = { ...GH_ALICE, providerAccountId: '102' };

// 攻击者：Gitee 上的同名账号（平台不同，可能是完全不同的自然人）
const GITEE_ALICE: OAuthProfile = {
  platform: 'gitee',
  providerAccountId: '900',
  login: 'alice',
  name: 'Alice?',
  email: 'alice@gitee.example.com',
  avatarUrl: null,
};

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

/** 走完整假 OAuth 登录（github/gitee 均可），会话落共享 repos，主 app 直接认 Cookie。 */
async function login(
  repos: StorageContext,
  profile: OAuthProfile,
  platform: 'github' | 'gitee',
): Promise<string> {
  const deps: ApiDeps =
    platform === 'github'
      ? { repos, authConfig: loadAuthConfig({}), githubAuthProvider: new FakeAuthProvider(profile) }
      : {
          repos,
          authConfig: loadAuthConfig({}),
          giteeAuthProvider: new FakeAuthProvider(profile, undefined, 'gitee'),
        };
  const authApp = await createApp(deps);
  const loginRes = await authApp.request(`/auth/${platform}/login`);
  expect(loginRes.status).toBe(302);
  const state = extractCookies(loginRes).jobagent_oauth_state;
  expect(state).toBeTruthy();
  const cb = await authApp.request(
    `/auth/${platform}/callback?state=${encodeURIComponent(state!)}&code=fake-code`,
    { headers: { Cookie: `jobagent_oauth_state=${state!}` } },
  );
  expect(cb.status).toBe(302);
  const session = extractCookies(cb).jobagent_session;
  expect(session).toBeTruthy();
  return `jobagent_session=${session!}`;
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
  loginName: string,
  platform: 'github' | 'gitee' | 'all' = 'github',
): Promise<void> {
  await repos.profiles.insert({
    id,
    analyzerVersion: 'schema-0.1-engine-0.1.0',
    subjectPlatform: platform,
    subjectLogin: loginName,
    dataWindowSince: '2025-09-01T00:00:00.000Z',
    dataWindowUntil: '2026-09-01T00:00:00.000Z',
    status: 'complete',
    snapshot: abilityProfile(id, loginName),
  });
}

async function accountIdOf(repos: StorageContext, p: OAuthProfile): Promise<string> {
  const account = await repos.accounts.getByProvider(p.platform, p.providerAccountId);
  expect(account).toBeTruthy();
  return account!.id;
}

describe('POST /profiles/:id/claim — 融合画像归属口径（P1-1）', () => {
  it('本人经主源 GitHub 认领融合画像 → 200', async () => {
    const repos = await createStorage({ sqlitePath: ':memory:' });
    await insertProfile(repos, 'prof-fused', 'alice', 'all');
    const cookie = await login(repos, GH_ALICE, 'github');
    const app = await createApp({ repos });

    const res = await app.request('/profiles/prof-fused/claim', {
      method: 'POST',
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { claimed: boolean; claimedProfileId: string };
    expect(body.claimed).toBe(true);
    expect(body.claimedProfileId).toBe('prof-fused');
    expect((await repos.profiles.getById('prof-fused'))?.subjectClaimed).toBe(true);
    const account = await repos.accounts.getById(await accountIdOf(repos, GH_ALICE));
    expect(account?.claimedProfileId).toBe('prof-fused');

    // 认领成功留审计事件；detail 只含主体 platform/login（不追加其他身份字段）
    const events = await repos.profileEvents.listByProfile('prof-fused');
    expect(events.filter((e) => e.event === 'claimed')).toHaveLength(1);
    const claimed = events.find((e) => e.event === 'claimed')!;
    expect(claimed.actorAccountId).toBe(account!.id);
    expect(JSON.parse(claimed.detailJson!)).toEqual({
      subjectPlatform: 'all',
      subjectLogin: 'alice',
    });
  });

  it('Gitee 同名账号认领融合画像 → 403（跨平台冒名封堵）', async () => {
    const repos = await createStorage({ sqlitePath: ':memory:' });
    await insertProfile(repos, 'prof-fused', 'alice', 'all');
    const cookie = await login(repos, GITEE_ALICE, 'gitee');
    const app = await createApp({ repos });

    const res = await app.request('/profiles/prof-fused/claim', {
      method: 'POST',
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('AUTH_NOT_PROFILE_OWNER');
    // 无任何副作用：画像仍未认领、攻击者账号无指针
    expect((await repos.profiles.getById('prof-fused'))?.subjectClaimed).toBe(false);
    const attacker = await repos.accounts.getById(await accountIdOf(repos, GITEE_ALICE));
    expect(attacker?.claimedProfileId).toBeNull();
  });

  it('伪造身份字段：GitHub 同名账号认领单源 Gitee 画像 → 403', async () => {
    const repos = await createStorage({ sqlitePath: ':memory:' });
    await insertProfile(repos, 'prof-gitee', 'alice', 'gitee');
    const cookie = await login(repos, GH_ALICE, 'github');
    const app = await createApp({ repos });

    const res = await app.request('/profiles/prof-gitee/claim', {
      method: 'POST',
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe('AUTH_NOT_PROFILE_OWNER');
    expect((await repos.profiles.getById('prof-gitee'))?.subjectClaimed).toBe(false);
  });

  it('Gitee 本人认领单源 Gitee 画像 → 200（单源双一致不受影响）', async () => {
    const repos = await createStorage({ sqlitePath: ':memory:' });
    await insertProfile(repos, 'prof-gitee', 'alice', 'gitee');
    const cookie = await login(repos, GITEE_ALICE, 'gitee');
    const app = await createApp({ repos });

    const res = await app.request('/profiles/prof-gitee/claim', {
      method: 'POST',
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
    expect((await repos.profiles.getById('prof-gitee'))?.subjectClaimed).toBe(true);
  });

  it('他人已认领的画像再认领 → 409 并提示申诉通道（不静默覆盖）', async () => {
    const repos = await createStorage({ sqlitePath: ':memory:' });
    await insertProfile(repos, 'prof-fused', 'alice', 'all');

    // 旧账号先行认领
    const oldCookie = await login(repos, GH_ALICE, 'github');
    const app = await createApp({ repos });
    const first = await app.request('/profiles/prof-fused/claim', {
      method: 'POST',
      headers: { Cookie: oldCookie },
    });
    expect(first.status).toBe(200);

    // 新账号（账号重建：同 login、不同 providerAccountId）再认领 → 409
    const newCookie = await login(repos, GH_ALICE_NEW, 'github');
    const second = await app.request('/profiles/prof-fused/claim', {
      method: 'POST',
      headers: { Cookie: newCookie },
    });
    expect(second.status).toBe(409);
    const body = (await second.json()) as { code: string; error: string };
    expect(body.code).toBe('AUTH_PROFILE_ALREADY_CLAIMED');
    expect(body.error).toContain('removal-request');
    // 归属未被抢夺：仍挂在旧账号
    const oldAccount = await repos.accounts.getById(await accountIdOf(repos, GH_ALICE));
    expect(oldAccount?.claimedProfileId).toBe('prof-fused');

    // 409 抢夺尝试同样留审计：操作者是发起抢夺的新账号，detail 仍只含主体信息
    const events = await repos.profileEvents.listByProfile('prof-fused');
    const conflicts = events.filter((e) => e.event === 'claim_conflict');
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.actorAccountId).toBe(await accountIdOf(repos, GH_ALICE_NEW));
    expect(JSON.parse(conflicts[0]!.detailJson!)).toEqual({
      subjectPlatform: 'all',
      subjectLogin: 'alice',
    });
  });

  it('本人重复认领保持幂等 200', async () => {
    const repos = await createStorage({ sqlitePath: ':memory:' });
    await insertProfile(repos, 'prof-1', 'alice', 'github');
    const cookie = await login(repos, GH_ALICE, 'github');
    const app = await createApp({ repos });

    for (let i = 0; i < 2; i++) {
      const res = await app.request('/profiles/prof-1/claim', {
        method: 'POST',
        headers: { Cookie: cookie },
      });
      expect(res.status).toBe(200);
    }
    // 幂等重复不产生重复 claimed 事件
    const events = await repos.profileEvents.listByProfile('prof-1');
    expect(events.filter((e) => e.event === 'claimed')).toHaveLength(1);
  });
});

describe('DELETE /profiles/:id — 归属校验与审计留痕（P1-1）', () => {
  it('Gitee 同名账号删除他人已认领融合画像 → 403 且零副作用', async () => {
    const repos = await createStorage({ sqlitePath: ':memory:' });
    await insertProfile(repos, 'prof-fused', 'alice', 'all');

    // 受害者经 GitHub 正常认领
    const ownerCookie = await login(repos, GH_ALICE, 'github');
    const app = await createApp({ repos });
    const claim = await app.request('/profiles/prof-fused/claim', {
      method: 'POST',
      headers: { Cookie: ownerCookie },
    });
    expect(claim.status).toBe(200);

    // 攻击者（Gitee 同名）尝试级联删除
    const attackerCookie = await login(repos, GITEE_ALICE, 'gitee');
    const res = await app.request('/profiles/prof-fused', {
      method: 'DELETE',
      headers: { Cookie: attackerCookie },
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe('AUTH_NOT_PROFILE_OWNER');

    // 零副作用：画像在、仍归属受害者、无 deleted 审计事件（认领时的 claimed 属正常留痕）
    expect(await repos.profiles.getById('prof-fused')).toBeTruthy();
    const owner = await repos.accounts.getById(await accountIdOf(repos, GH_ALICE));
    expect(owner?.claimedProfileId).toBe('prof-fused');
    const events = await repos.profileEvents.listByProfile('prof-fused');
    expect(events.filter((e) => e.event === 'deleted')).toHaveLength(0);
  });

  it('所有者删除融合画像 → 200 且先落 deleted 审计事件（含级联计数）', async () => {
    const repos = await createStorage({ sqlitePath: ':memory:' });
    await insertProfile(repos, 'prof-fused', 'alice', 'all');
    const cookie = await login(repos, GH_ALICE, 'github');
    const accountId = await accountIdOf(repos, GH_ALICE);

    // 认领 + 挂关联数据（证据/投递/面试各一条）
    const app = await createApp({ repos });
    await app.request('/profiles/prof-fused/claim', {
      method: 'POST',
      headers: { Cookie: cookie },
    });
    await repos.evidence.insert({
      id: 'ev-1',
      profileId: 'prof-fused',
      sourcePlatform: 'github',
      sourceType: 'commit',
      url: 'https://github.com/alice/repo/commit/abc',
      occurredAt: '2026-08-01T00:00:00.000Z',
      layer: 'L1',
      claim: 'committed',
      rawRef: 'raw-1',
    });
    await repos.applications.insert({
      id: 'app-1',
      profileId: 'prof-fused',
      targetTitle: 'Backend Engineer',
      targetCompany: 'Acme',
      status: 'applied',
      appliedAt: '2026-09-01T00:00:00.000Z',
      createdByAccountId: accountId,
    });
    await repos.interviews.insert({
      id: 'iv-1',
      profileId: 'prof-fused',
      targetTitle: 'Backend Engineer',
      targetCompany: 'Acme',
      scheduledStart: '2026-09-10T10:00:00.000Z',
      scheduledEnd: '2026-09-10T11:00:00.000Z',
      format: 'video',
      roundLabel: 'Round 1',
      status: 'scheduled',
      createdByAccountId: accountId,
    });

    const res = await app.request('/profiles/prof-fused', {
      method: 'DELETE',
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
    expect(await repos.profiles.getById('prof-fused')).toBeUndefined();

    // 审计事件：画像行已删，但事件保留（无 FK 刻意设计），可回溯操作者与级联规模
    // （认领时已落一条 claimed，这里只看 deleted）
    const events = await repos.profileEvents.listByProfile('prof-fused');
    const deleted = events.filter((e) => e.event === 'deleted');
    expect(deleted).toHaveLength(1);
    expect(deleted[0]!.actorAccountId).toBe(accountId);
    const detail = JSON.parse(deleted[0]!.detailJson!) as {
      subjectPlatform: string;
      subjectLogin: string;
      cascade: { evidence: number; applications: number; interviews: number };
    };
    expect(detail.subjectPlatform).toBe('all');
    expect(detail.subjectLogin).toBe('alice');
    expect(detail.cascade).toEqual({ evidence: 1, applications: 1, interviews: 1 });
  });
});

describe('claim-verifications 同口径回归（P1-1）', () => {
  it('已认领融合画像：Gitee 同名登录建声明 → 403（修复前按任一源放行）', async () => {
    const repos = await createStorage({ sqlitePath: ':memory:' });
    await insertProfile(repos, 'prof-fused', 'alice', 'all');
    await repos.profiles.markClaimed('prof-fused');
    const cookie = await login(repos, GITEE_ALICE, 'gitee');
    const app = await createApp({ repos });

    const res = await app.request('/profiles/prof-fused/claim-verifications', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ text: 'Built services in TypeScript' }),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe('AUTH_NOT_PROFILE_OWNER');
  });
});
