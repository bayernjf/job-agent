/**
 * 面试计划（interviews，handoff item45）API 集成测试：
 * - POST /interviews       未登录 401；profile 404；校验 400；创建默认值；关联投递并推进其状态到 interview
 * - GET  /interviews       仅返回本人创建、支持 profileId/status 过滤、按 scheduledStart 倒序
 * - PATCH /interviews/:id  改期/状态/结果录入；非本人资源 404；非法 rating/时间窗/空 patch 400
 * 全部内存 SQLite + FakeAuthProvider（不打网络），Hono app.request。
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

function abilityProfile(profileId: string, login: string): AbilityProfile {
  return {
    profileId,
    analyzerVersion: 'schema-0.1-engine-0.2.0',
    generatedAt: '2026-09-20T00:00:00.000Z',
    dataWindow: { since: '2025-09-20T00:00:00.000Z', until: '2026-09-20T00:00:00.000Z' },
    analysisLayers: ['L0', 'L1'],
    subject: { platform: 'github', login, profileUrl: `https://github.com/${login}`, claimed: false },
    summary: { headline: `${login} developer` },
    skillTags: [],
    activity: { longevityMonths: 12 },
    collaboration: { evidenceRefs: [] },
    authenticity: { status: 'likely_authentic', confidence: 0.8, signals: [] },
    interviewQuestions: [],
    caveats: [],
  };
}

async function insertProfile(repos: StorageContext, id: string, login: string): Promise<void> {
  await repos.profiles.insert({
    id,
    analyzerVersion: 'schema-0.1-engine-0.2.0',
    subjectPlatform: 'github',
    subjectLogin: login,
    dataWindowSince: '2025-09-20T00:00:00.000Z',
    dataWindowUntil: '2026-09-20T00:00:00.000Z',
    status: 'complete',
    snapshot: abilityProfile(id, login),
  });
}

/** 在共享内存库上为某身份完成一次 GitHub 登录，返回带会话 Cookie 的请求头。 */
async function loginUser(
  repos: StorageContext,
  identity: OAuthProfile,
): Promise<{ Cookie: string }> {
  const deps: ApiDeps = {
    repos,
    authConfig: loadAuthConfig({}),
    githubAuthProvider: new FakeAuthProvider(identity),
  };
  const app = await createApp(deps);
  const loginRes = await app.request('/auth/github/login');
  const stateCookies = extractCookies(loginRes);
  const state = stateCookies.jobagent_oauth_state;
  const cb = await app.request(
    `/auth/github/callback?state=${encodeURIComponent(state!)}&code=fake-code`,
    { headers: { Cookie: `jobagent_oauth_state=${state!}` } },
  );
  expect(cb.status).toBe(302);
  const session = extractCookies(cb).jobagent_session;
  expect(session).toBeTruthy();
  return { Cookie: `jobagent_session=${session!}` };
}

async function harness() {
  const repos = await createStorage({ sqlitePath: ':memory:' });
  const app = await createApp({ repos });
  return { repos, app };
}

const validBody = {
  profileId: 'p1',
  targetTitle: 'Senior Backend Engineer',
  targetCompany: 'Acme',
  scheduledStart: '2026-10-01T09:00:00.000Z',
  scheduledEnd: '2026-10-01T10:00:00.000Z',
  format: 'video',
  roundLabel: 'Technical screen',
  interviewerName: 'Recruiter A',
  interviewerEmail: 'r@acme.test',
};

describe('interviews endpoints — auth gate', () => {
  it('rejects anonymous create/list/patch with 401', async () => {
    const { app } = await harness();
    const post = await app.request('/interviews', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validBody),
    });
    expect(post.status).toBe(401);

    const list = await app.request('/interviews');
    expect(list.status).toBe(401);

    const patch = await app.request('/interviews/int-x', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'completed' }),
    });
    expect(patch.status).toBe(401);
  });
});

describe('POST /interviews', () => {
  it('creates with defaults, 404s unknown profile, 400s on invalid body', async () => {
    const { repos, app } = await harness();
    await insertProfile(repos, 'p1', 'alice');
    const auth = await loginUser(repos, ALICE);

    // profile 不存在 → 404
    const missing = await app.request('/interviews', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...auth },
      body: JSON.stringify({ ...validBody, profileId: 'nope' }),
    });
    expect(missing.status).toBe(404);

    // end <= start → 400
    const badRange = await app.request('/interviews', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...auth },
      body: JSON.stringify({
        ...validBody,
        scheduledEnd: '2026-10-01T09:00:00.000Z',
      }),
    });
    expect(badRange.status).toBe(400);

    // 非法邮箱 → 400
    const badEmail = await app.request('/interviews', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...auth },
      body: JSON.stringify({ ...validBody, interviewerEmail: 'not-an-email' }),
    });
    expect(badEmail.status).toBe(400);

    // 缺 roundLabel → 400
    const missingField = await app.request('/interviews', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...auth },
      body: JSON.stringify({ ...validBody, roundLabel: undefined }),
    });
    expect(missingField.status).toBe(400);

    // 合法（可空字段全省略）→ 201，默认 scheduled / id 前缀 / null 字段
    const created = await app.request('/interviews', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...auth },
      body: JSON.stringify({
        profileId: 'p1',
        targetTitle: 'Backend Engineer',
        scheduledStart: '2026-10-02T09:00:00.000Z',
        scheduledEnd: '2026-10-02T09:45:00.000Z',
        format: 'onsite',
        roundLabel: 'Onsite loop',
      }),
    });
    expect(created.status).toBe(201);
    const body = (await created.json()) as Record<string, unknown>;
    expect(String(body.id).startsWith('int-')).toBe(true);
    expect(body.status).toBe('scheduled');
    expect(body.targetCompany).toBeNull();
    expect(body.interviewerName).toBeNull();
    expect(body.applicationId).toBeNull();
    expect(body.outcome).toBeNull();
    expect(body.rating).toBeNull();
    expect(body.createdByAccountId).toBeTruthy();
  });

  it('links an application and advances its status, with mismatch validation', async () => {
    const { repos, app } = await harness();
    await insertProfile(repos, 'p1', 'alice');
    await insertProfile(repos, 'p2', 'carol');
    const auth = await loginUser(repos, ALICE);

    // 求职者侧公开创建一条投递（默认 applied）
    const appRes = await app.request('/profiles/p1/applications', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetTitle: 'Backend Engineer', targetCompany: 'Acme' }),
    });
    const application = (await appRes.json()) as { id: string; status: string };
    expect(application.status).toBe('applied');

    // 另一个画像的投递拿来关联 → 400
    const otherAppRes = await app.request('/profiles/p2/applications', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetTitle: 'Other', targetCompany: 'OtherCo' }),
    });
    const otherApplication = (await otherAppRes.json()) as { id: string };

    const mismatch = await app.request('/interviews', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...auth },
      body: JSON.stringify({ ...validBody, applicationId: otherApplication.id }),
    });
    expect(mismatch.status).toBe(400);

    // 不存在的 applicationId → 404
    const missingApp = await app.request('/interviews', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...auth },
      body: JSON.stringify({ ...validBody, applicationId: 'app-nope' }),
    });
    expect(missingApp.status).toBe(404);

    // 正确关联 → 201，投递被推进到 interview
    const linked = await app.request('/interviews', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...auth },
      body: JSON.stringify({ ...validBody, applicationId: application.id }),
    });
    expect(linked.status).toBe(201);
    const linkedBody = (await linked.json()) as { applicationId: string | null };
    expect(linkedBody.applicationId).toBe(application.id);
    const advanced = await repos.applications.getById(application.id);
    expect(advanced?.status).toBe('interview');
  });
});

describe('GET /interviews', () => {
  it('lists only the owner interviews, newest first, with filters', async () => {
    const { repos, app } = await harness();
    await insertProfile(repos, 'p1', 'alice');
    const alice = await loginUser(repos, ALICE);
    const bob = await loginUser(repos, BOB);

    // alice 两条（不同时间），bob 一条
    for (const [start, label] of [
      ['2026-10-01T09:00:00.000Z', 'Earlier'],
      ['2026-10-05T09:00:00.000Z', 'Later'],
    ] as const) {
      const res = await app.request('/interviews', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...alice },
        body: JSON.stringify({ ...validBody, scheduledStart: start, scheduledEnd: start.replace('09:00', '10:00'), roundLabel: label }),
      });
      expect(res.status).toBe(201);
    }
    const bobRes = await app.request('/interviews', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...bob },
      body: JSON.stringify({
        ...validBody,
        roundLabel: 'Bob interview',
        scheduledStart: '2026-10-09T09:00:00.000Z',
        scheduledEnd: '2026-10-09T10:00:00.000Z',
      }),
    });
    expect(bobRes.status).toBe(201);

    // alice 只看到自己两条，按 start 倒序
    const list = await app.request('/interviews', { headers: alice });
    const listBody = (await list.json()) as { items: Array<{ roundLabel: string }> };
    expect(listBody.items).toHaveLength(2);
    expect(listBody.items.map((i) => i.roundLabel)).toEqual(['Later', 'Earlier']);

    // profileId 过滤
    const filtered = await app.request('/interviews?profileId=p1', { headers: alice });
    expect((await filtered.json() as { items: unknown[] }).items).toHaveLength(2);
    const filteredOther = await app.request('/interviews?profileId=p2', { headers: alice });
    expect((await filteredOther.json() as { items: unknown[] }).items).toHaveLength(0);

    // status 过滤（默认全 scheduled）
    const byStatus = await app.request('/interviews?status=scheduled', { headers: alice });
    expect((await byStatus.json() as { items: unknown[] }).items).toHaveLength(2);
    const byDoneStatus = await app.request('/interviews?status=completed', { headers: alice });
    expect((await byDoneStatus.json() as { items: unknown[] }).items).toHaveLength(0);

    // 非法 status query → 400
    const badStatus = await app.request('/interviews?status=bogus', { headers: alice });
    expect(badStatus.status).toBe(400);
  });
});

describe('PATCH /interviews/:id', () => {
  it('records outcome, reschedules, enforces ownership and validation', async () => {
    const { repos, app } = await harness();
    await insertProfile(repos, 'p1', 'alice');
    const alice = await loginUser(repos, ALICE);
    const bob = await loginUser(repos, BOB);

    const created = await app.request('/interviews', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...alice },
      body: JSON.stringify(validBody),
    });
    const interview = (await created.json()) as { id: string };

    // bob 改 alice 的面试 → 404（不泄露存在）
    const foreign = await app.request(`/interviews/${interview.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...bob },
      body: JSON.stringify({ status: 'cancelled' }),
    });
    expect(foreign.status).toBe(404);

    // 空 patch → 400
    const empty = await app.request(`/interviews/${interview.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...alice },
      body: JSON.stringify({}),
    });
    expect(empty.status).toBe(400);

    // rating 越界 → 400
    const badRating = await app.request(`/interviews/${interview.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...alice },
      body: JSON.stringify({ rating: 6 }),
    });
    expect(badRating.status).toBe(400);

    // 单边改期导致 end<=start → 400（原 end 是 10:00，把 start 推到 11:00）
    const badReschedule = await app.request(`/interviews/${interview.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...alice },
      body: JSON.stringify({ scheduledStart: '2026-10-01T11:00:00.000Z' }),
    });
    expect(badReschedule.status).toBe(400);

    // 合法结果录入 → 200
    const result = await app.request(`/interviews/${interview.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...alice },
      body: JSON.stringify({
        status: 'completed',
        outcome: 'yes',
        rating: 4,
        feedbackNote: 'Solid system design; move to final round.',
      }),
    });
    expect(result.status).toBe(200);
    const resultBody = (await result.json()) as Record<string, unknown>;
    expect(resultBody.status).toBe('completed');
    expect(resultBody.outcome).toBe('yes');
    expect(resultBody.rating).toBe(4);

    // status 过滤现在能查到 completed
    const done = await app.request('/interviews?status=completed', { headers: alice });
    expect((await done.json() as { items: unknown[] }).items).toHaveLength(1);

    // 不存在 → 404
    const notFound = await app.request('/interviews/int-missing', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...alice },
      body: JSON.stringify({ status: 'cancelled' }),
    });
    expect(notFound.status).toBe(404);
  });
});
