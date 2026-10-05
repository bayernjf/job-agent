/**
 * 逐条声明核验 API 集成测试（决策 #23 批次 2）：
 *   - POST   /profiles/:id/claim-verifications  建声明并核验（授权矩阵 + 四态判定 + 证据反证）
 *   - GET    /profiles/:id/claim-verifications  列出结论
 *   - DELETE /claim-verifications/:id           撤回（创建者 / 画像本人）
 * 全部内存 SQLite + 仓储注入，不启服务器、不打网络、不调真实采集。
 */
import { describe, expect, it } from 'vitest';
import type { AbilityProfile, SkillTag } from '@jobagent/shared';
import { createStorage, type StorageContext } from '@jobagent/storage';
import { createApp } from './index.js';
import { FakeAuthProvider } from './fake-auth.js';
import type { AuthProvider, OAuthProfile } from './auth-provider.js';
import { loadAuthConfig } from './auth-config.js';

interface ClaimVerificationView {
  id: string;
  profileId: string | null;
  subject: { platform: string; login: string };
  claimText: string;
  claimSource: string;
  claimRef: string | null;
  verdict: string;
  matchedEvidenceRefs: string[];
  matchedEvidence: { id: string; url: string; claim: string }[];
  confidence: number | null;
  ruleVersion: string;
  requiredEvidenceCount: number;
  createdAt: string;
}
interface ClaimListResponse {
  items: ClaimVerificationView[];
}

function skill(name: string, evidenceRefs: string[]): SkillTag {
  return { name, kind: 'language', depth: 'proficient', confidence: 0.8, evidenceRefs };
}

function makeProfile(
  profileId: string,
  login: string,
  skills: SkillTag[],
  platform: 'github' | 'gitee' = 'github',
): AbilityProfile {
  return {
    profileId,
    analyzerVersion: 'schema-0.1-engine-0.2.0',
    generatedAt: '2026-10-05T00:00:00.000Z',
    dataWindow: { since: '2025-10-05T00:00:00.000Z', until: '2026-10-05T00:00:00.000Z' },
    analysisLayers: ['L0', 'L1'],
    subject: { platform, login, profileUrl: `https://${platform}.com/${login}`, claimed: false },
    summary: { headline: `${login} developer` },
    skillTags: skills,
    activity: { longevityMonths: 12 },
    collaboration: { evidenceRefs: [] },
    authenticity: { status: 'likely_authentic', confidence: 0.8, signals: [] },
    interviewQuestions: [],
    caveats: [],
  };
}

async function insertProfile(
  repos: StorageContext,
  p: AbilityProfile,
  opts: { claimed?: boolean } = {},
): Promise<void> {
  await repos.profiles.insert({
    id: p.profileId,
    analyzerVersion: p.analyzerVersion,
    subjectLogin: p.subject.login,
    subjectPlatform: p.subject.platform,
    dataWindowSince: p.dataWindow.since,
    dataWindowUntil: p.dataWindow.until,
    status: 'complete',
    snapshot: p,
  });
  if (opts.claimed) await repos.profiles.markClaimed(p.profileId);
}

async function insertEvidence(
  repos: StorageContext,
  profileId: string,
  id: string,
  url: string,
  claim: string,
): Promise<void> {
  await repos.evidence.insert({
    id,
    profileId,
    sourceType: 'commit',
    url,
    layer: 'L1',
    claim,
    rawRef: `ref-${id}`,
  });
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

/** 走一次假 OAuth 登录拿会话 Cookie；会话存在共享 repos，任何同 repos 的 app 都认。 */
async function loginCookie(repos: StorageContext, oauth: OAuthProfile): Promise<string> {
  const authApp = await createApp({
    repos,
    authConfig: loadAuthConfig({}),
    githubAuthProvider: new FakeAuthProvider(oauth),
  });
  const loginRes = await authApp.request('/auth/github/login');
  const state = extractCookies(loginRes).jobagent_oauth_state;
  const cb = await authApp.request(
    `/auth/github/callback?state=${encodeURIComponent(state!)}&code=fake-code`,
    { headers: { Cookie: `jobagent_oauth_state=${state!}` } },
  );
  return `jobagent_session=${extractCookies(cb).jobagent_session}`;
}

const RECRUITER: OAuthProfile = {
  platform: 'github',
  providerAccountId: '900',
  login: 'recruiter',
  name: 'Recruiter',
  email: 'recruiter@example.com',
  avatarUrl: null,
};

async function harness(providers?: { githubAuthProvider?: AuthProvider }): Promise<{
  app: Awaited<ReturnType<typeof createApp>>;
  repos: StorageContext;
}> {
  const repos = await createStorage({ sqlitePath: ':memory:' });
  const app = await createApp({
    repos,
    authConfig: loadAuthConfig({}),
    githubAuthProvider: providers?.githubAuthProvider ?? null,
  });
  return { app, repos };
}

/** 已声明招聘方的会话 Cookie（登录 + PUT /auth/recruiter） */
async function recruiterCookie(repos: StorageContext): Promise<string> {
  const app = await createApp({
    repos,
    authConfig: loadAuthConfig({}),
    githubAuthProvider: new FakeAuthProvider(RECRUITER),
  });
  const cookie = await loginCookie(repos, RECRUITER);
  const declared = await app.request('/auth/recruiter', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: '{}',
  });
  expect(declared.status).toBe(200);
  return cookie;
}

function postClaim(
  app: Awaited<ReturnType<typeof createApp>>,
  profileId: string,
  body: Record<string, unknown>,
  cookie?: string,
) {
  return app.request(`/profiles/${profileId}/claim-verifications`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body),
  });
}

describe('authorization matrix', () => {
  it('rejects anonymous callers with 401', async () => {
    const { app, repos } = await harness();
    await insertProfile(repos, makeProfile('p1', 'alice', []));
    const anon = await postClaim(app, 'p1', { text: 'Built services in TypeScript' });
    expect(anon.status).toBe(401);
    expect(((await anon.json()) as { code: string }).code).toBe('AUTH_REQUIRED');
  });

  it('rejects a plain logged-in user on an unclaimed profile with 403 RECRUITER_DECLARATION_REQUIRED', async () => {
    const { repos } = await harness();
    await insertProfile(repos, makeProfile('p1', 'alice', []));
    const cookie = await loginCookie(repos, {
      platform: 'github',
      providerAccountId: '42',
      login: 'not-a-recruiter',
      name: 'Plain',
      email: 'p@example.test',
      avatarUrl: null,
    });
    const app = await createApp({ repos, authConfig: loadAuthConfig({}) });
    const res = await postClaim(app, 'p1', { text: 'Built services in TypeScript' }, cookie);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe('RECRUITER_DECLARATION_REQUIRED');
  });

  it('lets the claimed profile owner read and write', async () => {
    const { repos } = await harness();
    await insertProfile(repos, makeProfile('p1', 'alice', [skill('TypeScript', ['e1', 'e2'])]), {
      claimed: true,
    });
    await insertEvidence(repos, 'p1', 'e1', 'https://github.com/alice/api/commit/a1', 'work on TypeScript services');
    await insertEvidence(repos, 'p1', 'e2', 'https://github.com/alice/api/commit/a2', 'more TypeScript');
    const cookie = await loginCookie(repos, {
      platform: 'github',
      providerAccountId: '1',
      login: 'alice',
      name: 'Alice',
      email: 'alice@example.test',
      avatarUrl: null,
    });
    const app = await createApp({ repos, authConfig: loadAuthConfig({}) });
    const res = await postClaim(app, 'p1', { text: 'Built services in TypeScript' }, cookie);
    expect(res.status).toBe(201);
    expect(((await res.json()) as ClaimVerificationView).verdict).toBe('supportable');
  });

  it('rejects a different logged-in user on a claimed profile with 403 AUTH_NOT_PROFILE_OWNER', async () => {
    const { repos } = await harness();
    await insertProfile(repos, makeProfile('p1', 'alice', []), { claimed: true });
    const cookie = await loginCookie(repos, {
      platform: 'github',
      providerAccountId: '2',
      login: 'bob',
      name: 'Bob',
      email: 'bob@example.test',
      avatarUrl: null,
    });
    const app = await createApp({ repos, authConfig: loadAuthConfig({}) });
    const res = await postClaim(app, 'p1', { text: 'Built services in TypeScript' }, cookie);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe('AUTH_NOT_PROFILE_OWNER');
  });

  it('lets a declared recruiter verify an unclaimed profile', async () => {
    const { repos } = await harness();
    await insertProfile(repos, makeProfile('p1', 'alice', []));
    const app = await createApp({ repos, authConfig: loadAuthConfig({}) });
    const cookie = await recruiterCookie(repos);
    const res = await postClaim(app, 'p1', { text: 'Excellent communication skills' }, cookie);
    expect(res.status).toBe(201);
    expect(((await res.json()) as ClaimVerificationView).verdict).toBe('insufficient_data');
  });
});

describe('verdicts (kernel wired through storage)', () => {
  async function seedProfileWithEvidence(
    repos: StorageContext,
    refs: string[],
  ): Promise<void> {
    await insertProfile(repos, makeProfile('p1', 'alice', [skill('TypeScript', refs)]));
    await insertEvidence(repos, 'p1', 'e1', 'https://github.com/alice/api/commit/a1', 'TypeScript refactor');
    await insertEvidence(repos, 'p1', 'e2', 'https://github.com/alice/api/commit/a2', 'TypeScript tooling');
  }

  it('supportable needs two genuine evidence rows', async () => {
    const { repos } = await harness();
    await seedProfileWithEvidence(repos, ['e1', 'e2']);
    const app = await createApp({ repos, authConfig: loadAuthConfig({}) });
    const res = await postClaim(app, 'p1', { text: 'Built services in TypeScript' }, await recruiterCookie(repos));
    const body = (await res.json()) as ClaimVerificationView;
    expect(body.verdict).toBe('supportable');
    expect(body.matchedEvidenceRefs.sort()).toEqual(['e1', 'e2']);
    expect(body.requiredEvidenceCount).toBe(2);
    // 验收 §8.1：每条判定都能带出可点开回溯的原始证据（同闸内水合，不补造）
    expect(body.matchedEvidence).toHaveLength(2);
    expect(body.matchedEvidence.map((e) => e.id).sort()).toEqual(['e1', 'e2']);
    expect(body.matchedEvidence.every((e) => e.url.startsWith('https://'))).toBe(true);
  });

  it('partial when only one evidence row supports the token', async () => {
    const { repos } = await harness();
    // 只有一条证据提到 TypeScript（另一条不相关）→ 支撑强度不足，判 partial 而非 supportable
    await insertProfile(repos, makeProfile('p1', 'alice', [skill('TypeScript', ['e1'])]));
    await insertEvidence(repos, 'p1', 'e1', 'https://github.com/alice/api/commit/a1', 'TypeScript refactor');
    await insertEvidence(repos, 'p1', 'e2', 'https://github.com/alice/api/commit/a2', 'update the docs');
    const app = await createApp({ repos, authConfig: loadAuthConfig({}) });
    const res = await postClaim(app, 'p1', { text: 'Built services in TypeScript' }, await recruiterCookie(repos));
    const body = (await res.json()) as ClaimVerificationView;
    expect(body.verdict).toBe('partial');
    expect(body.matchedEvidenceRefs).toEqual(['e1']);
  });

  it('no_trace when a checkable token has no matching evidence (and evidence exists)', async () => {
    const { repos } = await harness();
    await insertProfile(repos, makeProfile('p1', 'alice', []));
    await insertEvidence(repos, 'p1', 'e1', 'https://github.com/alice/api/commit/a1', 'TypeScript refactor');
    const app = await createApp({ repos, authConfig: loadAuthConfig({}) });
    const res = await postClaim(app, 'p1', { text: 'Built services in Rust' }, await recruiterCookie(repos));
    expect(((await res.json()) as ClaimVerificationView).verdict).toBe('no_trace');
  });

  it('insufficient_data when the claim carries no checkable token', async () => {
    const { repos } = await harness();
    await seedProfileWithEvidence(repos, ['e1', 'e2']);
    const app = await createApp({ repos, authConfig: loadAuthConfig({}) });
    const res = await postClaim(app, 'p1', { text: 'A great team player' }, await recruiterCookie(repos));
    const body = (await res.json()) as ClaimVerificationView;
    expect(body.verdict).toBe('insufficient_data');
    expect(body.matchedEvidenceRefs).toEqual([]);
    expect(body.confidence).toBeNull();
  });

  it('does not count a skill tag pointing at a nonexistent evidence id', async () => {
    const { repos } = await harness();
    // 标签声称有证据，但该 ref 在 evidence 表里不存在 → 结论只能是 no_trace，不能凭空 supportable
    await insertProfile(repos, makeProfile('p1', 'alice', [skill('TypeScript', ['ghost-ref'])]));
    await insertEvidence(repos, 'p1', 'e1', 'https://github.com/alice/api/commit/a1', 'unrelated rust work');
    const app = await createApp({ repos, authConfig: loadAuthConfig({}) });
    const res = await postClaim(app, 'p1', { text: 'Built services in TypeScript' }, await recruiterCookie(repos));
    const body = (await res.json()) as ClaimVerificationView;
    expect(body.verdict).toBe('no_trace');
    expect(body.matchedEvidenceRefs).toEqual([]);
  });

  it('resolves an explicit artifact URL against stored evidence', async () => {
    const { repos } = await harness();
    await insertProfile(repos, makeProfile('p1', 'alice', []));
    await insertEvidence(repos, 'p1', 'e1', 'https://github.com/alice/api/pull/7', 'fix the parser');
    const app = await createApp({ repos, authConfig: loadAuthConfig({}) });
    const res = await postClaim(
      app,
      'p1',
      { text: 'Authored https://github.com/alice/api/pull/7 to fix parsing' },
      await recruiterCookie(repos),
    );
    const body = (await res.json()) as ClaimVerificationView;
    expect(body.verdict).toBe('supportable');
    expect(body.matchedEvidenceRefs).toEqual(['e1']);
  });
});

describe('list and withdraw', () => {
  it('lists what was created and lets the creator withdraw it', async () => {
    const { repos } = await harness();
    await insertProfile(repos, makeProfile('p1', 'alice', []));
    const app = await createApp({ repos, authConfig: loadAuthConfig({}) });
    const cookie = await recruiterCookie(repos);
    const created = (await (
      await postClaim(app, 'p1', { text: 'Excellent communication skills' }, cookie)
    ).json()) as ClaimVerificationView;

    const list = await app.request('/profiles/p1/claim-verifications', { headers: { Cookie: cookie } });
    expect(list.status).toBe(200);
    expect(((await list.json()) as ClaimListResponse).items).toHaveLength(1);

    const del = await app.request(`/claim-verifications/${created.id}`, {
      method: 'DELETE',
      headers: { Cookie: cookie },
    });
    expect(del.status).toBe(200);
    const after = await app.request('/profiles/p1/claim-verifications', { headers: { Cookie: cookie } });
    expect(((await after.json()) as ClaimListResponse).items).toHaveLength(0);
  });

  it('refuses withdrawal by someone who is neither creator nor profile owner', async () => {
    const { repos } = await harness();
    await insertProfile(repos, makeProfile('p1', 'alice', []));
    const app = await createApp({ repos, authConfig: loadAuthConfig({}) });
    const created = (await (
      await postClaim(app, 'p1', { text: 'Excellent communication skills' }, await recruiterCookie(repos))
    ).json()) as ClaimVerificationView;

    const stranger = await loginCookie(repos, {
      platform: 'github',
      providerAccountId: '77',
      login: 'stranger',
      name: 'Stranger',
      email: 's@example.test',
      avatarUrl: null,
    });
    const del = await app.request(`/claim-verifications/${created.id}`, {
      method: 'DELETE',
      headers: { Cookie: stranger },
    });
    expect(del.status).toBe(403);
  });

  it('404s a missing claim and rejects an invalid create body', async () => {
    const { repos } = await harness();
    await insertProfile(repos, makeProfile('p1', 'alice', []));
    const app = await createApp({ repos, authConfig: loadAuthConfig({}) });
    const cookie = await recruiterCookie(repos);
    const missing = await app.request('/claim-verifications/claimv-nope', {
      method: 'DELETE',
      headers: { Cookie: cookie },
    });
    expect(missing.status).toBe(404);
    const bad = await postClaim(app, 'p1', { text: '' }, cookie);
    expect(bad.status).toBe(400);
  });
});
