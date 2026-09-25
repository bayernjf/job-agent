/**
 * 企业侧人才检索 + 求职者投递记录 API 集成测试（痛点解决方案批次 2）：
 * - GET    /candidates                 人才检索（只读 complete 画像、过滤/分页、非法枚举 400）
 * - GET    /profiles/:id/applications  列出投递
 * - POST   /profiles/:id/applications  新增投递（默认值、404/400）
 * - PATCH  /applications/:id           局部更新状态（404/非法枚举）
 * 全部用内存 SQLite + 仓储注入，不启动服务器、不打网络。
 */
import { describe, expect, it } from 'vitest';
import type { AbilityProfile, AuthenticityStatus, SkillTag } from '@jobagent/shared';
import { createStorage, type StorageContext } from '@jobagent/storage';
import { createApp } from './index.js';
import { FakeAuthProvider } from './fake-auth.js';
import type { OAuthProfile } from './auth-provider.js';
import { loadAuthConfig } from './auth-config.js';

interface CandidateItem {
  profileId: string;
  login: string;
  skillCount: number;
}
interface CandidateListResponse {
  items: CandidateItem[];
  total: number;
  limit: number;
  offset: number;
}
interface ApplicationResponse {
  id: string;
  status: string;
  origin: string;
  appliedAt: string;
  targetTitle: string;
  targetCompany: string;
  note: string | null;
  /** 013 起的行级归属；单行响应回显，列表响应刻意剥掉（见 api 的 publicApplication） */
  createdByAccountId?: string | null;
}
interface ApplicationListResponse {
  items: ApplicationResponse[];
}

function makeProfile(
  profileId: string,
  login: string,
  opts: {
    status?: AuthenticityStatus;
    confidence?: number;
    skills?: SkillTag[];
    headline?: string;
    platform?: 'github' | 'gitee';
  } = {},
): AbilityProfile {
  return {
    profileId,
    analyzerVersion: 'schema-0.1-engine-0.2.0',
    generatedAt: '2026-09-16T00:00:00.000Z',
    dataWindow: { since: '2025-09-16T00:00:00.000Z', until: '2026-09-16T00:00:00.000Z' },
    analysisLayers: ['L0', 'L1'],
    subject: {
      platform: opts.platform ?? 'github',
      login,
      profileUrl: `https://github.com/${login}`,
      claimed: false,
    },
    summary: { headline: opts.headline ?? `${login} developer` },
    skillTags: opts.skills ?? [],
    activity: { longevityMonths: 12 },
    collaboration: { evidenceRefs: [] },
    authenticity: {
      status: opts.status ?? 'likely_authentic',
      confidence: opts.confidence ?? 0.8,
      signals: [],
    },
    interviewQuestions: [],
    caveats: [],
  };
}

function skill(name: string): SkillTag {
  return { name, kind: 'language', depth: 'proficient', confidence: 0.8, evidenceRefs: [] };
}

async function insertProfile(
  repos: StorageContext,
  p: AbilityProfile,
  status: 'complete' | 'partial' = 'complete',
): Promise<void> {
  await repos.profiles.insert({
    id: p.profileId,
    analyzerVersion: p.analyzerVersion,
    subjectLogin: p.subject.login,
    subjectPlatform: p.subject.platform,
    dataWindowSince: p.dataWindow.since,
    dataWindowUntil: p.dataWindow.until,
    status,
    snapshot: p,
  });
}

async function harness() {
  const repos = await createStorage({ sqlitePath: ':memory:' });
  const app = await createApp({ repos });
  return { app, repos };
}

describe('GET /candidates', () => {
  it('returns an empty list on a fresh database', async () => {
    const { app } = await harness();
    const res = await app.request('/candidates');
    expect(res.status).toBe(200);
    const body = (await res.json()) as CandidateListResponse;
    expect(body.items).toEqual([]);
    expect(body.total).toBe(0);
    expect(body.limit).toBe(20);
    expect(body.offset).toBe(0);
  });

  it('only scans complete profiles and filters by skill + confidence', async () => {
    const { repos } = await harness();
    await insertProfile(
      repos,
      makeProfile('p1', 'alice', { confidence: 0.9, skills: [skill('TypeScript'), skill('React')] }),
    );
    await insertProfile(
      repos,
      makeProfile('p2', 'bob', {
        status: 'mixed_signals',
        confidence: 0.5,
        skills: [skill('Python'), skill('TypeScript')],
      }),
    );
    await insertProfile(
      repos,
      makeProfile('p3', 'carol', { confidence: 0.95, skills: [skill('Rust')] }),
      'partial', // partial 不进候选人库
    );
    const appWithData = await createApp({ repos });

    const all = await appWithData.request('/candidates');
    const allBody = (await all.json()) as CandidateListResponse;
    expect(allBody.total).toBe(2); // carol(partial) 被排除
    expect(allBody.items.map((c) => c.login)).toEqual(['alice', 'bob']); // confidence desc

    const ts = await appWithData.request('/candidates?skills=typescript');
    const tsBody = (await ts.json()) as CandidateListResponse;
    expect(tsBody.total).toBe(2);

    const confident = await appWithData.request('/candidates?minConfidence=0.9');
    const confidentBody = (await confident.json()) as CandidateListResponse;
    expect(confidentBody.items.map((c) => c.login)).toEqual(['alice']);
  });

  it('rejects unknown authenticity values and bad numbers with 400', async () => {
    const { app } = await harness();
    const badEnum = await app.request('/candidates?authenticity=likely_authentic,bogus');
    expect(badEnum.status).toBe(400);
    const badNumber = await app.request('/candidates?minConfidence=5');
    expect(badNumber.status).toBe(400);
    const badSort = await app.request('/candidates?sortBy=hack');
    expect(badSort.status).toBe(400);
  });

  it('filters by authenticity allow-list and keyword, and paginates', async () => {
    const { repos } = await harness();
    await insertProfile(
      repos,
      makeProfile('p1', 'alice', { status: 'likely_authentic', skills: [skill('Rust')], headline: 'systems' }),
    );
    await insertProfile(
      repos,
      makeProfile('p2', 'bob', { status: 'suspicious', confidence: 0.2, skills: [skill('Rust')] }),
    );
    const app = await createApp({ repos });

    const authentic = await app.request('/candidates?authenticity=likely_authentic');
    const authenticBody = (await authentic.json()) as CandidateListResponse;
    expect(authenticBody.items.map((c) => c.login)).toEqual(['alice']);

    const keyword = await app.request('/candidates?keyword=systems');
    const keywordBody = (await keyword.json()) as CandidateListResponse;
    expect(keywordBody.items.map((c) => c.login)).toEqual(['alice']);

    const paged = await app.request('/candidates?limit=1&offset=0');
    const pagedBody = (await paged.json()) as CandidateListResponse;
    expect(pagedBody.items).toHaveLength(1);
    expect(pagedBody.total).toBe(2);
  });
});

describe('applications endpoints', () => {
  it('creates, lists and patches an application, with defaults and validation', async () => {
    const { app, repos } = await harness();
    await insertProfile(repos, makeProfile('p1', 'alice'));

    // profile 不存在 → 404
    const missingProfile = await app.request('/profiles/nope/applications', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetTitle: 'Engineer', targetCompany: 'Acme' }),
    });
    expect(missingProfile.status).toBe(404);

    // 缺 targetCompany → 400
    const invalid = await app.request('/profiles/p1/applications', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetTitle: 'Engineer' }),
    });
    expect(invalid.status).toBe(400);

    // 合法创建 → 201，默认 status=applied / origin=manual
    const created = await app.request('/profiles/p1/applications', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targetTitle: 'Senior Engineer',
        targetCompany: 'Acme',
        targetUrl: 'https://example.test/job/1',
        source: 'greenhouse',
      }),
    });
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as ApplicationResponse;
    expect(createdBody.status).toBe('applied');
    expect(createdBody.origin).toBe('manual');
    expect(createdBody.appliedAt).toBeTruthy();
    const appId = createdBody.id;
    expect(appId.startsWith('app-')).toBe(true);

    // 再插一条更早的，验证列表按 applied_at 倒序
    await app.request('/profiles/p1/applications', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targetTitle: 'Older Role',
        targetCompany: 'Oldco',
        appliedAt: '2026-08-01T00:00:00.000Z',
      }),
    });
    const list = await app.request('/profiles/p1/applications');
    const listBody = (await list.json()) as ApplicationListResponse;
    expect(listBody.items).toHaveLength(2);
    expect(listBody.items[0]!.targetTitle).toBe('Senior Engineer');

    // 非法状态 PATCH → 400
    const badPatch = await app.request(`/applications/${appId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'hired' }),
    });
    expect(badPatch.status).toBe(400);

    // 空 PATCH → 400
    const emptyPatch = await app.request(`/applications/${appId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(emptyPatch.status).toBe(400);

    // 合法 PATCH → interview
    const patched = await app.request(`/applications/${appId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'interview', note: '约了一面' }),
    });
    expect(patched.status).toBe(200);
    const patchedBody = (await patched.json()) as ApplicationResponse;
    expect(patchedBody.status).toBe('interview');
    expect(patchedBody.note).toBe('约了一面');

    // 不存在 → 404
    const notFound = await app.request('/applications/app-missing', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'offer' }),
    });
    expect(notFound.status).toBe(404);
  });

  it('lists applications scoped to the profile and 404s on unknown profile', async () => {
    const { app, repos } = await harness();
    await insertProfile(repos, makeProfile('p1', 'alice'));
    const unknown = await app.request('/profiles/nope/applications');
    expect(unknown.status).toBe(404);
    const empty = await app.request('/profiles/p1/applications');
    expect(empty.status).toBe(200);
    const emptyBody = (await empty.json()) as ApplicationListResponse;
    expect(emptyBody.items).toEqual([]);
  });
});

// ── 投递数据隐私（决策 #17-F11，handoff item60 T01–T03）───────────────────────
// 认领即隐私开关：未认领画像没有可授权的主体、报告本身按 #1-A 就是公开的，因此
// 匿名读写链路保持原样；一旦本人认领，读与写都收归该账号。有主行只有主能改，
// 非主一律 404（不泄露存在），无主历史行沿用现状。

const ALICE: OAuthProfile = {
  platform: 'github',
  providerAccountId: '101',
  login: 'alice',
  name: 'Alice',
  email: 'alice@example.com',
  avatarUrl: null,
};
const BOB: OAuthProfile = {
  platform: 'github',
  providerAccountId: '202',
  login: 'bob',
  name: 'Bob',
  email: 'bob@example.com',
  avatarUrl: null,
};

function cookieHeader(res: Response, name: string): string | undefined {
  const raws =
    typeof res.headers.getSetCookie === 'function'
      ? res.headers.getSetCookie()
      : [res.headers.get('set-cookie') ?? ''];
  for (const raw of raws) {
    const pair = raw.split(';')[0] ?? '';
    const eq = pair.indexOf('=');
    if (eq > 0 && pair.slice(0, eq).trim() === name) return decodeURIComponent(pair.slice(eq + 1));
  }
  return undefined;
}

/** 在共享内存库上走完一次 GitHub 登录，返回可复用的会话 Cookie 头。 */
async function loginUser(repos: StorageContext, identity: OAuthProfile): Promise<Record<string, string>> {
  const app = await createApp({
    repos,
    authConfig: loadAuthConfig({}),
    githubAuthProvider: new FakeAuthProvider(identity),
  });
  const state = cookieHeader(await app.request('/auth/github/login'), 'jobagent_oauth_state');
  const cb = await app.request(
    `/auth/github/callback?state=${encodeURIComponent(state!)}&code=fake-code`,
    { headers: { Cookie: `jobagent_oauth_state=${state!}` } },
  );
  const session = cookieHeader(cb, 'jobagent_session');
  expect(session).toBeTruthy();
  return { Cookie: `jobagent_session=${session!}` };
}

async function createAppWith(repos: StorageContext) {
  return createApp({ repos });
}

describe('application privacy (#17-F11)', () => {
  it('leaves the anonymous journey on an unclaimed profile intact and hides ownership in lists', async () => {
    const repos = await createStorage({ sqlitePath: ':memory:' });
    await insertProfile(repos, makeProfile('p1', 'alice'));
    const app = await createAppWith(repos);

    const created = await app.request('/profiles/p1/applications', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ targetTitle: 'Engineer', targetCompany: 'Acme' }),
    });
    expect(created.status).toBe(201);
    const row = (await created.json()) as ApplicationResponse;
    // 匿名写入不回改归属，历史语义不变
    expect(row.createdByAccountId).toBeNull();

    const list = await app.request('/profiles/p1/applications');
    expect(list.status).toBe(200);
    const body = (await list.json()) as ApplicationListResponse;
    expect(body.items).toHaveLength(1);
    // 列表不外发账号 id（可与他人身份关联的标识）
    expect(body.items[0]).not.toHaveProperty('createdByAccountId');

    // 无主行仍可被改（存量兼容，PRD F11 验收 1/4）
    const patched = await app.request(`/applications/${row.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'viewed' }),
    });
    expect(patched.status).toBe(200);
  });

  it('stamps the creator on a logged-in write and lets only that creator patch it', async () => {
    const repos = await createStorage({ sqlitePath: ':memory:' });
    await insertProfile(repos, makeProfile('p1', 'alice'));
    const alice = await loginUser(repos, ALICE);
    const app = await createAppWith(repos);

    const created = await app.request('/profiles/p1/applications', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...alice },
      body: JSON.stringify({ targetTitle: 'Engineer', targetCompany: 'Acme' }),
    });
    expect(created.status).toBe(201);
    const row = (await created.json()) as ApplicationResponse & { createdByAccountId?: string | null };
    expect(row.createdByAccountId).toMatch(/^acc-/);

    // 换一个登录身份改：404（与"不存在"同形），且行内容不动
    const bob = await loginUser(repos, BOB);
    const stolen = await app.request(`/applications/${row.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...bob },
      body: JSON.stringify({ status: 'offer' }),
    });
    expect(stolen.status).toBe(404);
    const after = (await (await app.request('/profiles/p1/applications', { headers: alice })).json()) as
      | ApplicationListResponse
      | { items?: ApplicationResponse[] };
    expect((after as ApplicationListResponse).items?.[0]?.status).toBe('applied');

    // 本人改得动
    const own = await app.request(`/applications/${row.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...alice },
      body: JSON.stringify({ status: 'interview' }),
    });
    expect(own.status).toBe(200);
  });

  it('locks a claimed profile\'s application pipeline to its owner', async () => {
    const repos = await createStorage({ sqlitePath: ':memory:' });
    await insertProfile(repos, makeProfile('p1', 'alice'));
    const alice = await loginUser(repos, ALICE);
    const app = await createAppWith(repos);

    const claim = await app.request('/profiles/p1/claim', { method: 'POST', headers: alice });
    expect(claim.status).toBe(200);

    // 匿名：未登录 → 401，且不回任何画像/投递内容
    const anonGet = await app.request('/profiles/p1/applications');
    expect(anonGet.status).toBe(401);
    expect(((await anonGet.json()) as { items?: unknown }).items).toBeUndefined();
    const anonPost = await app.request('/profiles/p1/applications', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ targetTitle: 'X', targetCompany: 'Y' }),
    });
    expect(anonPost.status).toBe(401);

    // 别人登录：认不是他 → 403
    const bob = await loginUser(repos, BOB);
    const otherGet = await app.request('/profiles/p1/applications', { headers: bob });
    expect(otherGet.status).toBe(403);

    // 本人：正常
    const ownGet = await app.request('/profiles/p1/applications', { headers: alice });
    expect(ownGet.status).toBe(200);
    expect(((await ownGet.json()) as ApplicationListResponse).items).toEqual([]);
  });
});
