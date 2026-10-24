/**
 * 招聘方自建 JD（决策 #25，B3-a 最小一刀，2026-10-13）API 集成测试。
 * 钉住三件事：
 * 1. 闸：未登录 401、已登录未声明招聘方 403（沿用 F10 判据，不开新身份线）；
 * 2. **隐私不变量**：私有 JD 不出现在任何公开池读取口（列表 / stats / 画像推荐 / 匹配），
 *    单条读取只对本人返回，越权一律 404 不泄露存在；
 * 3. 身份由服务端决定：客户端塞 source/createdByAccountId/jobId 都不生效。
 * 全部内存 SQLite + FakeAuthProvider（不打网络），Hono app.request。
 */
import { describe, expect, it } from 'vitest';
import type { AbilityProfile } from '@jobagent/shared';
import { createStorage, type StorageContext } from '@jobagent/storage';
import { createApp, type ApiDeps } from './index.js';
import { FakeAuthProvider } from './fake-auth.js';
import type { OAuthProfile } from './auth-provider.js';
import { loadAuthConfig } from './auth-config.js';

const RICK: OAuthProfile = {
  platform: 'github',
  providerAccountId: '901',
  login: 'rick-recruiter',
  name: 'Rick',
  email: 'rick@example.com',
  avatarUrl: null,
};
const MORTY: OAuthProfile = {
  platform: 'github',
  providerAccountId: '902',
  login: 'morty-recruiter',
  name: 'Morty',
  email: 'morty@example.com',
  avatarUrl: null,
};
const CANDIDATE: OAuthProfile = {
  platform: 'github',
  providerAccountId: '903',
  login: 'gordanite',
  name: 'Gordanite',
  email: 'gordan@example.com',
  avatarUrl: null,
};

const JD = {
  title: 'Staff Agent Engineer',
  company: 'In-house Team',
  location: 'Shanghai',
  remote: false,
  tags: ['typescript', 'agents'],
  description: 'Own our internal agent platform.',
};

/** 在共享内存库上登录，可选显式声明招聘方（F10），返回请求用的 Cookie。 */
async function loginWithCookie(
  repos: StorageContext,
  identity: OAuthProfile,
  opts: { declareRecruiter?: boolean } = {},
): Promise<string> {
  const deps: ApiDeps = {
    repos,
    authConfig: loadAuthConfig({}),
    githubAuthProvider: new FakeAuthProvider(identity),
  };
  const app = await createApp(deps);
  const loginRes = await app.request('/auth/github/login');
  const stateCookie = loginRes.headers
    .getSetCookie()
    .find((c) => c.startsWith('jobagent_oauth_state='));
  const state = stateCookie?.split(';')[0]?.slice('jobagent_oauth_state='.length);
  expect(state).toBeTruthy();
  const cb = await app.request(
    `/auth/github/callback?state=${encodeURIComponent(state!)}&code=fake-code`,
    { headers: { Cookie: `jobagent_oauth_state=${state!}` } },
  );
  expect(cb.status).toBe(302);
  const session = cb.headers
    .getSetCookie()
    .find((c) => c.startsWith('jobagent_session='))
    ?.split(';')[0];
  expect(session).toBeTruthy();
  if (opts.declareRecruiter) {
    const declared = await app.request('/auth/recruiter', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: `${session!}` },
      body: '{}',
    });
    expect(declared.status).toBe(200);
  }
  return `${session!}`;
}

function minimalProfile(profileId: string, login: string, skills: string[]): AbilityProfile {
  return {
    profileId,
    analyzerVersion: 'schema-0.1-engine-0.1.0',
    generatedAt: '2026-10-13T00:00:00.000Z',
    dataWindow: { since: '2025-10-13T00:00:00.000Z', until: '2026-10-13T00:00:00.000Z' },
    analysisLayers: ['L0', 'L1'],
    subject: {
      platform: 'github',
      login,
      profileUrl: `https://github.com/${login}`,
      claimed: false,
    },
    summary: { headline: 'Test developer' },
    skillTags: skills.map((name) => ({
      name,
      kind: 'language' as const,
      depth: 'proficient' as const,
      confidence: 0.8,
      evidenceRefs: [],
    })),
    activity: { longevityMonths: 12 },
    collaboration: { evidenceRefs: [] },
    authenticity: { status: 'likely_authentic', confidence: 0.8, signals: [] },
    interviewQuestions: [],
    caveats: [],
  };
}

async function harness() {
  const repos = await createStorage({ sqlitePath: ':memory:' });
  const app = await createApp({ repos });
  return { repos, app };
}

/** Hono 把 `res.json()` 定型成 unknown，这里按各端点的真实形状收窄（不写 any）。 */
type PostingJson = {
  id: string;
  jobId: string;
  title: string;
  source: string;
  status: string;
  sourceUrl: string;
  createdByAccountId: string | null;
};
type CodeJson = { code?: string; error?: string };
type ListJson = { items: PostingJson[] };
type MatchesJson = { matches: Array<{ posting: { id: string } }> };
type StatsJson = { active: number; inactive: number };

async function jsonAs<T>(res: Response | Promise<Response>): Promise<T> {
  return (await (await res).json()) as T;
}

async function publish(
  app: Awaited<ReturnType<typeof createApp>>,
  cookie: string,
  body: unknown,
) {
  return app.request('/job-postings/recruiter', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify(body),
  });
}

describe('recruiter-published JDs', () => {
  it('rejects anonymous publishing with 401', async () => {
    const { app } = await harness();
    const anon = await app.request('/job-postings/recruiter', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(JD),
    });
    expect(anon.status).toBe(401);
  });

  it('rejects undeclared members with RECRUITER_DECLARATION_REQUIRED', async () => {
    const { repos, app } = await harness();
    const cookie = await loginWithCookie(repos, CANDIDATE);
    const res = await publish(app, cookie, JD);
    expect(res.status).toBe(403);
    expect(await jsonAs<CodeJson>(res)).toMatchObject({ code: 'RECRUITER_DECLARATION_REQUIRED' });
  });

  it('publishes for a declared recruiter and ignores client-supplied identity fields', async () => {
    const { repos, app } = await harness();
    const cookie = await loginWithCookie(repos, RICK, { declareRecruiter: true });
    const res = await publish(app, cookie, {
      ...JD,
      // 攻击面：客户端试图伪造归属与来源（把私有岗位伪装成公开池的 remoteok 行）
      source: 'remoteok',
      createdByAccountId: 'acct-evil',
      jobId: 'hijacked',
      status: 'inactive',
    });
    expect(res.status).toBe(201);
    const body = await jsonAs<PostingJson>(res);
    expect(body).toMatchObject({
      source: 'recruiter',
      title: JD.title,
      status: 'active',
    });
    expect(body.createdByAccountId).not.toBe('acct-evil');
    expect(body.jobId).not.toBe('hijacked');
    expect(String(body.sourceUrl)).toContain('recruiter.invalid');
  });

  it('keeps a private JD out of every public pool read', async () => {
    const { repos, app } = await harness();
    const cookie = await loginWithCookie(repos, RICK, { declareRecruiter: true });
    const published = await jsonAs<PostingJson>(await publish(app, cookie, JD));

    // 公开池里放一条正常聚合行作为正对照：公开读取确实有内容，只是不含私有行
    await repos.jobPostings.upsertBatch(
      [
        {
          jobId: 'pool-1',
          source: 'remoteok',
          sourceUrl: 'https://pool.example.test/1',
          title: 'Backend Engineer',
          company: 'Pool Co',
          remote: true,
          postedAt: '2026-10-01T00:00:00.000Z',
          fetchedAt: new Date().toISOString(),
          tags: ['typescript'],
          normalizedKey: 'pool-1',
        },
      ],
      new Date().toISOString(),
    );

    const list = await jsonAs<ListJson>(app.request('/job-postings?limit=500'));
    expect(list.items.length).toBeGreaterThan(0);
    expect(list.items.some((p: { id: string }) => p.id === published.id)).toBe(false);

    const stats = await jsonAs<StatsJson>(app.request('/job-postings/stats'));
    expect(stats.active).toBe(1);

    // C 端画像推荐口：技能与私有 JD 完全对得上，也不能出现它
    await repos.profiles.insert({
      id: 'prof-1',
      analyzerVersion: 'schema-0.1-engine-0.1.0',
      subjectPlatform: 'github',
      subjectLogin: 'someone',
      dataWindowSince: '2025-10-13T00:00:00.000Z',
      dataWindowUntil: '2026-10-13T00:00:00.000Z',
      status: 'complete',
      snapshot: minimalProfile('prof-1', 'someone', ['typescript', 'agents']),
    });
    const rec = await jsonAs<MatchesJson>(
      app.request('/profiles/prof-1/job-recommendations?limit=50'),
    );
    expect(rec.matches.length).toBeGreaterThan(0);
    expect(
      rec.matches.some((m: { posting: { id: string } }) => m.posting.id === published.id),
    ).toBe(false);

    // 匹配端点同样不收它
    const match = await app.request('/job-postings/match', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ skills: ['typescript', 'agents'], candidateLimit: 500 }),
    });
    const matchBody = await jsonAs<MatchesJson>(match);
    expect(
      matchBody.matches.some((m: { posting: { id: string } }) => m.posting.id === published.id),
    ).toBe(false);
  });

  it('reads a single private posting only for its owner; everyone else gets 404', async () => {
    const { repos, app } = await harness();
    const rick = await loginWithCookie(repos, RICK, { declareRecruiter: true });
    const id = (await jsonAs<PostingJson>(await publish(app, rick, JD))).id;

    expect((await app.request(`/job-postings/${id}`, { headers: { Cookie: rick } })).status).toBe(
      200,
    );

    const other = await loginWithCookie(repos, MORTY, { declareRecruiter: true });
    expect((await app.request(`/job-postings/${id}`, { headers: { Cookie: other } })).status).toBe(
      404,
    );
    expect((await app.request(`/job-postings/${id}`)).status).toBe(404);
  });

  it('lists only my own postings per account', async () => {
    const { repos, app } = await harness();
    const rick = await loginWithCookie(repos, RICK, { declareRecruiter: true });
    const morty = await loginWithCookie(repos, MORTY, { declareRecruiter: true });
    await publish(app, rick, JD);
    await publish(app, morty, { ...JD, title: 'Morty Role' });

    const rickList = await jsonAs<ListJson>(
      app.request('/job-postings/recruiter', { headers: { Cookie: rick } }),
    );
    expect(rickList.items).toHaveLength(1);
    expect(rickList.items[0]!.title).toBe(JD.title);
    const mortyList = await jsonAs<ListJson>(
      app.request('/job-postings/recruiter', { headers: { Cookie: morty } }),
    );
    expect(mortyList.items).toHaveLength(1);
    expect(mortyList.items[0]!.title).toBe('Morty Role');

    // 未登录读自己的列表＝401（静态路径 /recruiter 不被 /:id 吞掉）
    expect((await app.request('/job-postings/recruiter')).status).toBe(401);
  });

  it('retires only one own posting and keeps it visible as inactive', async () => {
    const { repos, app } = await harness();
    const rick = await loginWithCookie(repos, RICK, { declareRecruiter: true });
    const morty = await loginWithCookie(repos, MORTY, { declareRecruiter: true });
    const id = (await jsonAs<PostingJson>(await publish(app, rick, JD))).id;

    // 非本人下线：404，且不泄露这条岗位存在
    const intruder = await app.request(`/job-postings/recruiter/${id}`, {
      method: 'DELETE',
      headers: { Cookie: morty },
    });
    expect(intruder.status).toBe(404);

    const mine = await app.request(`/job-postings/recruiter/${id}`, {
      method: 'DELETE',
      headers: { Cookie: rick },
    });
    expect(mine.status).toBe(200);
    expect((await jsonAs<PostingJson>(mine)).status).toBe('inactive');

    // 下线后公开池依旧看不到它（本来就是看不到），我的列表仍含它、状态为 inactive
    const list = await jsonAs<ListJson>(
      app.request('/job-postings/recruiter', { headers: { Cookie: rick } }),
    );
    expect(list.items).toHaveLength(1);
    expect(list.items[0]!.status).toBe('inactive');
    const pool = await jsonAs<ListJson>(app.request('/job-postings?limit=500'));
    expect(pool.items.some((p: { id: string }) => p.id === id)).toBe(false);
  });

  it('validates the body', async () => {
    const { repos, app } = await harness();
    const rick = await loginWithCookie(repos, RICK, { declareRecruiter: true });
    expect((await publish(app, rick, { ...JD, title: '   ' })).status).toBe(400);
    expect((await publish(app, rick, { ...JD, tags: new Array(26).fill('x') })).status).toBe(400);
    expect((await publish(app, rick, { ...JD, company: '' })).status).toBe(400);
    const badJson = await app.request('/job-postings/recruiter', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: rick },
      body: '{',
    });
    expect(badJson.status).toBe(400);
  });

  it('caps active postings per account', async () => {
    const { repos, app } = await harness();
    const rick = await loginWithCookie(repos, RICK, { declareRecruiter: true });
    for (let i = 0; i < 50; i += 1) {
      const res = await publish(app, rick, { ...JD, title: `Role ${i}` });
      expect(res.status).toBe(201);
    }
    const overflow = await publish(app, rick, { ...JD, title: 'Role 50' });
    expect(overflow.status).toBe(429);
    expect(await jsonAs<CodeJson>(overflow)).toMatchObject({ code: 'TOO_MANY_POSTINGS' });

    // 正对照：下线一条后又能发出去（闸数的是在册 active 条数，不是历史总数）
    const mineList = await jsonAs<ListJson>(
      app.request('/job-postings/recruiter', { headers: { Cookie: rick } }),
    );
    expect(mineList.items).toHaveLength(50);
    const retired = await app.request(`/job-postings/recruiter/${mineList.items[0]!.id}`, {
      method: 'DELETE',
      headers: { Cookie: rick },
    });
    expect(retired.status).toBe(200);
    expect((await publish(app, rick, { ...JD, title: 'Role 50 again' })).status).toBe(201);
  });
});

/**
 * 决策 #25 补口（迁移 037）：面试可以挂在招聘方自己发布的岗位下，于是"这条岗位现在有几个人"
 * 答得出。归属校验必须在写入前——别人的私有岗位和公开池的行都不能挂。
 */
describe('interviews linked to a recruiter posting', () => {
  const interviewBody = (postingId: string) => ({
    profileId: 'prof-1',
    targetTitle: JD.title,
    scheduledStart: '2026-10-20T09:00:00.000Z',
    scheduledEnd: '2026-10-20T10:00:00.000Z',
    format: 'video',
    roundLabel: '一面 · 技术筛',
    postingId,
  });

  async function seeded() {
    const { repos, app } = await harness();
    await repos.profiles.insert({
      id: 'prof-1',
      analyzerVersion: 'schema-0.1-engine-0.1.0',
      subjectPlatform: 'github',
      subjectLogin: 'someone',
      dataWindowSince: '2025-10-13T00:00:00.000Z',
      dataWindowUntil: '2026-10-13T00:00:00.000Z',
      status: 'complete',
      snapshot: minimalProfile('prof-1', 'someone', ['typescript']),
    });
    const rick = await loginWithCookie(repos, RICK, { declareRecruiter: true });
    const morty = await loginWithCookie(repos, MORTY, { declareRecruiter: true });
    return { repos, app, rick, morty };
  }

  it('links an interview to my own posting and filters by it', async () => {
    const { app, rick } = await seeded();
    const postingId = (await jsonAs<PostingJson>(await publish(app, rick, JD))).id;

    const created = await app.request('/interviews', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: rick },
      body: JSON.stringify(interviewBody(postingId)),
    });
    expect(created.status).toBe(201);
    expect((await jsonAs<{ postingId: string | null }>(created)).postingId).toBe(postingId);

    const filtered = await jsonAs<{ items: Array<{ id: string }> }>(
      app.request(`/interviews?postingId=${postingId}`, { headers: { Cookie: rick } }),
    );
    expect(filtered.items).toHaveLength(1);

    // 换个 postingId 就是另一条岗位：本人作用域不变，岗位维度收窄
    const other = await jsonAs<{ items: unknown[] }>(
      app.request('/interviews?postingId=jhp-nonexistent', { headers: { Cookie: rick } }),
    );
    expect(other.items).toHaveLength(0);
  });

  it('refuses another recruiter\'s posting and a public-pool row, both with 404', async () => {
    const { repos, app, rick, morty } = await seeded();
    const rickPosting = (await jsonAs<PostingJson>(await publish(app, rick, JD))).id;
    // 正对照先落一条合法的：后面两次 404 才有东西可对照（否则"0 条面试"可能是路由根本没写对）
    const own = await app.request('/interviews', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: rick },
      body: JSON.stringify(interviewBody(rickPosting)),
    });
    expect(own.status).toBe(201);
    // 公开池里放一条真实存在的行（聚合来源、无归属），它的 id 同样不能挂
    await repos.jobPostings.upsertBatch(
      [
        {
          jobId: 'pool-1',
          source: 'remoteok',
          sourceUrl: 'https://pool.example.test/1',
          title: 'Backend Engineer',
          company: 'Pool Co',
          remote: true,
          postedAt: '2026-10-01T00:00:00.000Z',
          fetchedAt: '2026-10-13T00:00:00.000Z',
          tags: ['typescript'],
          normalizedKey: 'pool-1',
        },
      ],
      '2026-10-13T00:00:00.000Z',
    );
    const poolId = (await jsonAs<ListJson>(app.request('/job-postings?limit=5'))).items[0]!.id;

    // Morty 想用 Rick 的私有岗位：404（不泄露这条岗位存在），且不落库
    const steal = await app.request('/interviews', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: morty },
      body: JSON.stringify(interviewBody(rickPosting)),
    });
    expect(steal.status).toBe(404);
    const mortyList = await jsonAs<{ items: unknown[] }>(
      app.request('/interviews', { headers: { Cookie: morty } }),
    );
    expect(mortyList.items).toHaveLength(0);

    // 公开池的行不是招聘方 pipeline 的载体：存在，但照样 404
    const poolLink = await app.request('/interviews', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: rick },
      body: JSON.stringify(interviewBody(poolId)),
    });
    expect(poolLink.status).toBe(404);
    // 正对照：上面那次成功的自挂已落库，说明 404 不是"路由没写对"的假绿
    const mine = await jsonAs<{ items: Array<{ postingId: string | null }> }>(
      app.request('/interviews', { headers: { Cookie: rick } }),
    );
    expect(mine.items).toHaveLength(1);
    expect(mine.items[0]!.postingId).toBe(rickPosting);
  });

  it('still accepts interviews without any posting (the pre-037 shape)', async () => {
    const { app, rick } = await seeded();
    const body = interviewBody('ignored');
    delete (body as Record<string, unknown>).postingId;
    const res = await app.request('/interviews', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: rick },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(201);
    expect((await jsonAs<{ postingId: string | null }>(res)).postingId).toBeNull();
  });
});
