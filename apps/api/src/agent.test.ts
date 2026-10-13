/**
 * 求职 Agent 工作台（阶段 1）API 集成测试。
 *
 * 覆盖：登录闸与归属、画像必须本人已认领、创建即扫一轮（created→…→awaiting_approval）、
 * 待投清单、确认/拒绝、限频闸（按来源 24h 的已确认+已投递）、标记已投写投递记录并转 tracking、
 * 按需装配简历/求职信、cron tick 鉴权与推进、偏好被活跃任务引用时不可删除。
 * 全部内存 SQLite + FakeAuthProvider（不打网络），Hono app.request。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AbilityProfile, EvidenceItem } from '@jobagent/shared';
import {
  createStorage,
  makeJobPostingId,
  type NewJobPosting,
  type StorageContext,
} from '@jobagent/storage';
import { createApp, type ApiDeps } from './index.js';
import { FakeAuthProvider } from './fake-auth.js';
import type { OAuthProfile } from './auth-provider.js';
import { loadAuthConfig } from './auth-config.js';
import { loadAgentConfig } from './agent-config.js';
import type { JdExtractor } from '@jobagent/agent-core';

const ALICE: OAuthProfile = {
  platform: 'github',
  providerAccountId: '901',
  login: 'workbench-alice',
  name: 'Alice',
  email: 'alice@example.com',
  avatarUrl: null,
};
const BOB: OAuthProfile = {
  platform: 'github',
  providerAccountId: '902',
  login: 'workbench-bob',
  name: 'Bob',
  email: 'bob@example.com',
  avatarUrl: null,
};

const CRON_SECRET = 'agent-tick-test-secret';
let previousCronSecret: string | undefined;
beforeAll(() => {
  previousCronSecret = process.env.CRON_SECRET;
  process.env.CRON_SECRET = CRON_SECRET;
});
afterAll(() => {
  if (previousCronSecret === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = previousCronSecret;
});

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

/** 两个可回溯证据：一个 PR、一个 issue（技能必须挂真实证据才进交付物）。 */
const EVIDENCE: EvidenceItem[] = [
  {
    evidenceId: 'ev-ts-pr',
    sourcePlatform: 'github',
    sourceType: 'pr',
    url: 'https://github.com/acme/api/pull/42',
    occurredAt: '2026-08-01T00:00:00.000Z',
    layer: 'L1',
    claim: 'Merged PR #42 in acme/api',
    rawRef: '42',
  },
  {
    evidenceId: 'ev-ts-issue',
    sourcePlatform: 'github',
    sourceType: 'issue',
    url: 'https://github.com/acme/web/issues/7',
    occurredAt: '2026-07-01T00:00:00.000Z',
    layer: 'L1',
    claim: 'Opened issue #7 in acme/web',
    rawRef: '7',
  },
];

function abilityProfile(profileId: string, login: string): AbilityProfile {
  return {
    profileId,
    analyzerVersion: '0.1-0.9',
    generatedAt: '2026-10-01T00:00:00.000Z',
    dataWindow: { since: '2025-10-01T00:00:00.000Z', until: '2026-10-01T00:00:00.000Z' },
    analysisLayers: ['L0', 'L1'],
    subject: {
      platform: 'github',
      login,
      displayName: login,
      profileUrl: `https://github.com/${login}`,
      claimed: false,
    },
    summary: { headline: 'TypeScript developer' },
    skillTags: [
      {
        name: 'TypeScript',
        kind: 'language',
        depth: 'proficient',
        confidence: 0.95,
        evidenceRefs: ['ev-ts-pr', 'ev-ts-issue'],
      },
    ],
    activity: { longevityMonths: 24, metrics: { totalRepos: 6, totalPullRequests: 3, mergedPullRequests: 2 } },
    collaboration: { evidenceRefs: ['ev-ts-pr'] },
    authenticity: { status: 'likely_authentic', confidence: 0.85, signals: [] },
    interviewQuestions: [],
    caveats: [],
  };
}

async function insertProfile(repos: StorageContext, id: string, login: string): Promise<void> {
  await repos.profiles.insert({
    id,
    analyzerVersion: '0.1-0.9',
    subjectPlatform: 'github',
    subjectLogin: login,
    dataWindowSince: '2025-10-01T00:00:00.000Z',
    dataWindowUntil: '2026-10-01T00:00:00.000Z',
    status: 'complete',
    snapshot: abilityProfile(id, login),
  });
  await repos.evidence.importFromProfile(id, EVIDENCE);
}

/**
 * 岗位池夹具的"源站仍列着它"时刻。扫描按 `last_seen_at` 的新鲜窗口（`JOB_STALE_DAYS`
 * 默认 7 天）排除已下架岗位，所以夹具时间**必须相对"现在"生成**——写死日期会在若干天后
 * 让扫描静默产出零票据，测试看起来像功能坏了。
 */
const POOL_SEEN_AT = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();

/** 与生产采集一致：`jobId` 就是 (source, sourceUrl) 的派生 id（岗位池主键）。 */
function posting(overrides: Partial<NewJobPosting> = {}): NewJobPosting {
  const base = {
    source: 'greenhouse' as const,
    sourceUrl: 'https://boards.example.com/acme/jobs/1',
    title: 'Senior TypeScript Engineer',
    company: 'Acme',
    location: 'Remote - US',
    remote: true,
    salaryMin: 150_000,
    salaryMax: 190_000,
    salaryCurrency: 'USD',
    tags: ['typescript', 'node'],
    description: 'Build TypeScript services.',
    postedAt: '2026-10-01T00:00:00.000Z',
    fetchedAt: POOL_SEEN_AT,
    normalizedKey: 'acme-senior-typescript-engineer',
  };
  const merged = { ...base, ...overrides };
  return { ...merged, jobId: makeJobPostingId(merged.source, merged.sourceUrl) };
}

async function loginUser(
  repos: StorageContext,
  identity: OAuthProfile,
): Promise<{ Cookie: string; app: Awaited<ReturnType<typeof createApp>> }> {
  const deps: ApiDeps = {
    repos,
    authConfig: loadAuthConfig({}),
    githubAuthProvider: new FakeAuthProvider(identity),
  };
  const app = await createApp(deps);
  const loginRes = await app.request('/auth/github/login');
  const state = extractCookies(loginRes).jobagent_oauth_state;
  const cb = await app.request(
    `/auth/github/callback?state=${encodeURIComponent(state!)}&code=fake-code`,
    { headers: { Cookie: `jobagent_oauth_state=${state!}` } },
  );
  expect(cb.status).toBe(302);
  const session = extractCookies(cb).jobagent_session;
  expect(session).toBeTruthy();
  return { Cookie: `jobagent_session=${session!}`, app };
}

/** 起一个内存库 + 已登录的 Alice，并给出常用请求助手。 */
async function harness() {
  const repos = await createStorage({ sqlitePath: ':memory:' });
  const { Cookie } = await loginUser(repos, ALICE);
  const app = await createApp({
    repos,
    authConfig: loadAuthConfig({}),
    githubAuthProvider: new FakeAuthProvider(ALICE),
  });
  const json = (path: string, init: RequestInit = {}) =>
    app.request(path, {
      ...init,
      headers: { 'Content-Type': 'application/json', Cookie, ...(init.headers ?? {}) },
    });
  return { repos, app, Cookie, json };
}

const PREFERENCE = {
  label: '远程全栈',
  targetTitles: ['typescript'],
  skills: ['TypeScript'],
  remoteOnly: false,
  minTier: 'mid' as const,
};

describe('agent workbench — auth and ownership', () => {
  it('rejects anonymous access to every agent endpoint with 401', async () => {
    const repos = await createStorage({ sqlitePath: ':memory:' });
    const app = await createApp({ repos });
    for (const [method, path] of [
      ['GET', '/agent/preferences'],
      ['POST', '/agent/preferences'],
      ['GET', '/agent/runs'],
      ['POST', '/agent/runs'],
      ['GET', '/agent/runs/run-x'],
      ['GET', '/agent/runs/run-x/events'],
      ['POST', '/agent/runs/run-x/scan'],
      ['POST', '/agent/runs/run-x/view'],
      ['POST', '/agent/runs/run-x/approve'],
      ['GET', '/agent/runs/run-x/pending-approvals'],
      ['POST', '/agent/intents/intent-x/mark-submitted'],
      ['POST', '/agent/intents/intent-x/outcome'],
      ['GET', '/agent/extension/pending-fills'],
      ['GET', '/agent/intents/intent-x/resume'],
      ['GET', '/agent/intents/intent-x/cover-letter'],
    ] as const) {
      const res = await app.request(path, { method, body: method === 'GET' ? undefined : '{}' });
      expect(res.status, `${method} ${path}`).toBe(401);
    }
  });

  it('refuses to create a run on a profile the account has not claimed (403)', async () => {
    const { repos, json } = await harness();
    await insertProfile(repos, 'p-unclaimed', ALICE.login);
    const pref = await json('/agent/preferences', { method: 'POST', body: JSON.stringify(PREFERENCE) });
    const { preference } = (await pref.json()) as { preference: { preferenceId: string } };

    const res = await json('/agent/runs', {
      method: 'POST',
      body: JSON.stringify({ preferenceId: preference.preferenceId, profileId: 'p-unclaimed' }),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe('AGENT_PROFILE_NOT_OWNED');
  });

  it('hides another account’s runs and preferences behind 404', async () => {
    const repos = await createStorage({ sqlitePath: ':memory:' });
    await insertProfile(repos, 'p-alice', ALICE.login);
    const alice = await loginUser(repos, ALICE);
    const app = await createApp({ repos, authConfig: loadAuthConfig({}), githubAuthProvider: new FakeAuthProvider(ALICE) });
    // Alice 认领 + 建偏好/任务
    await app.request('/profiles/p-alice/claim', { method: 'POST', headers: { Cookie: alice.Cookie } });
    const prefRes = await app.request('/agent/preferences', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: alice.Cookie },
      body: JSON.stringify({ ...PREFERENCE, targetTitles: ['nothing-matches'] }),
    });
    const { preference } = (await prefRes.json()) as { preference: { preferenceId: string } };
    const runRes = await app.request('/agent/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: alice.Cookie },
      body: JSON.stringify({ preferenceId: preference.preferenceId, profileId: 'p-alice' }),
    });
    const run = (await runRes.json()) as { run: { runId: string } };

    // Bob 用同一个 app 实例（换 Cookie）
    const bob = await loginUser(repos, BOB);
    const bobGet = await app.request(`/agent/runs/${run.run.runId}`, { headers: { Cookie: bob.Cookie } });
    expect(bobGet.status).toBe(404);
    expect(((await bobGet.json()) as { code: string }).code).toBe('AGENT_RUN_NOT_FOUND');
    const bobPref = await app.request(`/agent/preferences/${preference.preferenceId}`, {
      headers: { Cookie: bob.Cookie },
    });
    expect(bobPref.status).toBe(404);
    const bobDelete = await app.request(`/agent/preferences/${preference.preferenceId}`, {
      method: 'DELETE',
      headers: { Cookie: bob.Cookie },
    });
    expect(bobDelete.status).toBe(404);
  });
});

describe('agent workbench — stage 1 loop', () => {
  it('creates a run, scans once and lands on the human approval gate with prepared tickets', async () => {
    const { repos, app, json } = await harness();
    await insertProfile(repos, 'p-1', ALICE.login);
    const claim = await json('/profiles/p-1/claim', { method: 'POST' });
    expect(claim.status).toBe(200);
    await repos.jobPostings.upsertBatch([posting()], POOL_SEEN_AT);

    const prefRes = await json('/agent/preferences', { method: 'POST', body: JSON.stringify(PREFERENCE) });
    const { preference } = (await prefRes.json()) as { preference: { preferenceId: string } };

    const runRes = await json('/agent/runs', {
      method: 'POST',
      body: JSON.stringify({ preferenceId: preference.preferenceId, profileId: 'p-1' }),
    });
    expect(runRes.status).toBe(201);
    const body = (await runRes.json()) as {
      run: { runId: string; status: string };
      events: Array<{ event: string; fromStatus: string | null; toStatus: string }>;
      intents: Array<{ intentId: string; status: string; jobId: string; matchTier: string; report: { reasons: Array<{ code: string; skill: string }> } }>;
      scan: { candidateCount: number; matchedCount: number };
    };
    expect(body.run.status).toBe('awaiting_approval');
    // 状态机的四步迁移全部落审计日志，可回放
    expect(body.events.map((e) => e.event)).toEqual(['validate', 'start', 'candidates_ready', 'generated']);
    expect(body.events[0]).toMatchObject({ fromStatus: 'created', toStatus: 'configured' });
    expect(body.scan.matchedCount).toBe(1);
    expect(body.scan.candidateCount).toBe(1);

    expect(body.intents).toHaveLength(1);
    const intent = body.intents[0]!;
    expect(intent.status).toBe('pending');
    expect(intent.jobId).toBe(makeJobPostingId('greenhouse', 'https://boards.example.com/acme/jobs/1'));
    // 票据必须同时带上岗位池主键：工作台下载简历走 POST /resumes/build，按池主键取岗位行
    expect((intent as unknown as { job: { postingId?: string } }).job.postingId).toBe(intent.jobId);
    expect(intent.matchTier).toBe('high');
    expect(intent.report.reasons).toEqual(
      expect.arrayContaining([{ code: 'title_match', skill: 'TypeScript', points: 3 }]),
    );

    // 待投清单 = 待确认 + 待用户自己投
    const pendingRes = await json(`/agent/runs/${body.run.runId}/pending-approvals`);
    expect(pendingRes.status).toBe(200);
    const pending = (await pendingRes.json()) as { items: unknown[]; status: string };
    expect(pending.status).toBe('awaiting_approval');
    expect(pending.items).toHaveLength(1);

    // 确认：票据置 approved，任务离开人机闸进入 submitting（阶段 2 机器执行态，§10.4 A1）
    const approveRes = await json(`/agent/runs/${body.run.runId}/approve`, {
      method: 'POST',
      body: JSON.stringify({ intentIds: [intent.intentId] }),
    });
    expect(approveRes.status).toBe(200);
    const approved = (await approveRes.json()) as {
      approved: number;
      run: { status: string };
      intents: Array<{ status: string }>;
    };
    expect(approved.approved).toBe(1);
    expect(approved.run.status).toBe('submitting');
    expect(approved.intents[0]!.status).toBe('approved');

    // 扩展回执（用户点提交后）：submitting → submitted → tracking，写 origin=agent 投递记录
    const submittedRes = await json(`/agent/intents/${intent.intentId}/mark-submitted`, { method: 'POST' });
    expect(submittedRes.status).toBe(200);
    const submitted = (await submittedRes.json()) as {
      applicationId: string;
      run: { status: string };
      intent: { status: string };
    };
    expect(submitted.intent.status).toBe('submitted');
    expect(submitted.run.status).toBe('tracking');

    const applications = await repos.applications.listByProfile('p-1');
    expect(applications).toHaveLength(1);
    expect(applications[0]).toMatchObject({
      id: submitted.applicationId,
      origin: 'agent',
      submitIntentId: intent.intentId,
      jobId: intent.jobId,
      targetTitle: 'Senior TypeScript Engineer',
      status: 'applied',
    });

    // 幂等：重复标记不再写第二条投递
    const again = await json(`/agent/intents/${intent.intentId}/mark-submitted`, { method: 'POST' });
    expect(again.status).toBe(200);
    expect(await repos.applications.listByProfile('p-1')).toHaveLength(1);

    // D1 结果回标必须有读侧：写进去读不回来，「回标」在界面上就无处安放，样本也攒不起来
    const subs = (await (
      await json(`/agent/runs/${body.run.runId}/submissions`)
    ).json()) as {
      items: Array<{
        intentId: string;
        status: string;
        applicationId: string | null;
        outcomeFeedback: string | null;
      }>;
    };
    expect(subs.items).toHaveLength(1);
    expect(subs.items[0]).toMatchObject({
      intentId: intent.intentId,
      status: 'submitted',
      applicationId: submitted.applicationId,
      outcomeFeedback: null,
    });

    const outcomeRes = await json(`/agent/intents/${intent.intentId}/outcome`, {
      method: 'POST',
      body: JSON.stringify({ outcome: 'interview' }),
    });
    expect(outcomeRes.status).toBe(200);

    const after = (await (
      await json(`/agent/runs/${body.run.runId}/submissions`)
    ).json()) as {
      items: Array<{ outcomeFeedback: string | null; outcomeFeedbackAt: string | null }>;
    };
    expect(after.items[0]!.outcomeFeedback).toBe('interview');
    expect(after.items[0]!.outcomeFeedbackAt).toBeTruthy();

    // 事件流完整可回放（阶段 2：approve → submitting，回执分 submitted + track 两步）
    const viewRes = await json(`/agent/runs/${body.run.runId}`);
    const view = (await viewRes.json()) as { events: Array<{ event: string }> };
    expect(view.events.map((e) => e.event)).toEqual([
      'validate',
      'start',
      'candidates_ready',
      'generated',
      'approve',
      'submitted',
      'track',
    ]);
  });

  it('keeps the stage-1 compatibility path: mark-submitted without approve goes straight to tracking', async () => {
    const { repos, json } = await harness();
    await insertProfile(repos, 'p-1', ALICE.login);
    await json('/profiles/p-1/claim', { method: 'POST' });
    await repos.jobPostings.upsertBatch([posting()], POOL_SEEN_AT);
    const prefRes = await json('/agent/preferences', { method: 'POST', body: JSON.stringify(PREFERENCE) });
    const { preference } = (await prefRes.json()) as { preference: { preferenceId: string } };
    const runRes = await json('/agent/runs', {
      method: 'POST',
      body: JSON.stringify({ preferenceId: preference.preferenceId, profileId: 'p-1' }),
    });
    const run = (await runRes.json()) as { run: { runId: string }; intents: Array<{ intentId: string }> };

    // 不 approve 直接回填（用户自己投完回来标已投）：票据 pending → submitted，任务 tracking
    const submittedRes = await json(`/agent/intents/${run.intents[0]!.intentId}/mark-submitted`, {
      method: 'POST',
    });
    expect(submittedRes.status).toBe(200);
    const submitted = (await submittedRes.json()) as { run: { status: string } };
    expect(submitted.run.status).toBe('tracking');

    const viewRes = await json(`/agent/runs/${run.run.runId}`);
    const view = (await viewRes.json()) as { events: Array<{ event: string }> };
    // 兼容路径无 approve：awaiting_approval --submitted--> tracking 一步到位
    expect(view.events.map((e) => e.event)).toEqual([
      'validate',
      'start',
      'candidates_ready',
      'generated',
      'submitted',
    ]);
  });

  it('refuses to mark a rejected intent submitted (409) and never writes an application', async () => {
    const { repos, json } = await harness();
    await insertProfile(repos, 'p-1', ALICE.login);
    await json('/profiles/p-1/claim', { method: 'POST' });
    await repos.jobPostings.upsertBatch([posting()], POOL_SEEN_AT);
    const prefRes = await json('/agent/preferences', { method: 'POST', body: JSON.stringify(PREFERENCE) });
    const { preference } = (await prefRes.json()) as { preference: { preferenceId: string } };
    const runRes = await json('/agent/runs', {
      method: 'POST',
      body: JSON.stringify({ preferenceId: preference.preferenceId, profileId: 'p-1' }),
    });
    const run = (await runRes.json()) as { run: { runId: string }; intents: Array<{ intentId: string }> };

    const rejectRes = await json(`/agent/runs/${run.run.runId}/reject`, {
      method: 'POST',
      body: JSON.stringify({ intentId: run.intents[0]!.intentId, reason: '公司不合适' }),
    });
    expect(rejectRes.status).toBe(200);

    // rejected 票据不可复活为 submitted：路由 invalid 分支 409，且不留投递记录
    const res = await json(`/agent/intents/${run.intents[0]!.intentId}/mark-submitted`, { method: 'POST' });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe('AGENT_INVALID_TRANSITION');
    expect(await repos.applications.listByProfile('p-1')).toHaveLength(0);
    expect((await repos.submitIntents.getById(run.intents[0]!.intentId))!.status).toBe('rejected');
  });

  it('rejects an intent, returns to watching, and never re-recommends the same job', async () => {
    const { repos, json } = await harness();
    await insertProfile(repos, 'p-1', ALICE.login);
    await json('/profiles/p-1/claim', { method: 'POST' });
    await repos.jobPostings.upsertBatch([posting()], POOL_SEEN_AT);
    const prefRes = await json('/agent/preferences', { method: 'POST', body: JSON.stringify(PREFERENCE) });
    const { preference } = (await prefRes.json()) as { preference: { preferenceId: string } };
    const runRes = await json('/agent/runs', {
      method: 'POST',
      body: JSON.stringify({ preferenceId: preference.preferenceId, profileId: 'p-1' }),
    });
    const run = (await runRes.json()) as { run: { runId: string }; intents: Array<{ intentId: string }> };

    const rejectRes = await json(`/agent/runs/${run.run.runId}/reject`, {
      method: 'POST',
      body: JSON.stringify({ intentId: run.intents[0]!.intentId, reason: '公司不合适' }),
    });
    expect(rejectRes.status).toBe(200);
    const rejected = (await rejectRes.json()) as {
      run: { status: string };
      intents: Array<{ status: string; rejectReason: string | null }>;
    };
    expect(rejected.run.status).toBe('watching');
    expect(rejected.intents[0]).toMatchObject({ status: 'rejected', rejectReason: '公司不合适' });

    // 再扫一轮：已出过票据的岗位不再重复推荐，且不算失败
    const scanRes = await json(`/agent/runs/${run.run.runId}/scan`, { method: 'POST' });
    expect(scanRes.status).toBe(200);
    const rescanned = (await scanRes.json()) as {
      run: { status: string };
      intents: unknown[];
      scan: { candidateCount: number };
    };
    expect(rescanned.run.status).toBe('watching');
    expect(rescanned.intents).toHaveLength(1);
    expect(rescanned.scan.candidateCount).toBe(0);
  });

  it('produces no tickets when nothing passes the preference filter or the quality gate', async () => {
    const { repos, json } = await harness();
    await insertProfile(repos, 'p-1', ALICE.login);
    await json('/profiles/p-1/claim', { method: 'POST' });
    // 一条与偏好关键词不符、一条关键词命中（标签）但技能只命中标签 → 分数低于质量闸
    await repos.jobPostings.upsertBatch(
      [
        posting({ sourceUrl: 'https://boards.example.com/acme/jobs/2', title: 'Marketing Manager', tags: ['marketing'], description: 'Own campaigns.' }),
        posting({ sourceUrl: 'https://boards.example.com/acme/jobs/3', title: 'Backend Engineer', tags: ['typescript'], description: 'Rust only.' }),
      ],
      POOL_SEEN_AT,
    );
    const prefRes = await json('/agent/preferences', { method: 'POST', body: JSON.stringify(PREFERENCE) });
    const { preference } = (await prefRes.json()) as { preference: { preferenceId: string } };
    const runRes = await json('/agent/runs', {
      method: 'POST',
      body: JSON.stringify({ preferenceId: preference.preferenceId, profileId: 'p-1' }),
    });
    const body = (await runRes.json()) as {
      run: { status: string };
      intents: unknown[];
      events: Array<{ event: string }>;
    };
    expect(body.run.status).toBe('watching');
    expect(body.intents).toHaveLength(0);
    expect(body.events.map((e) => e.event)).toEqual(['validate', 'start', 'rescan']);
  });

  it('enforces the per-source daily submit limit on approve (all-or-nothing)', async () => {
    const { repos, json } = await harness();
    await insertProfile(repos, 'p-1', ALICE.login);
    await json('/profiles/p-1/claim', { method: 'POST' });
    await repos.jobPostings.upsertBatch(
      [
        posting({ sourceUrl: 'https://boards.example.com/acme/jobs/1' }),
        posting({ sourceUrl: 'https://boards.example.com/acme/jobs/2', title: 'TypeScript Platform Engineer' }),
      ],
      POOL_SEEN_AT,
    );
    const prefRes = await json('/agent/preferences', {
      method: 'POST',
      body: JSON.stringify({ ...PREFERENCE, dailySubmitLimit: 1 }),
    });
    const { preference } = (await prefRes.json()) as { preference: { preferenceId: string } };
    const runRes = await json('/agent/runs', {
      method: 'POST',
      body: JSON.stringify({ preferenceId: preference.preferenceId, profileId: 'p-1' }),
    });
    const run = (await runRes.json()) as { run: { runId: string }; intents: Array<{ intentId: string }> };
    expect(run.intents).toHaveLength(2);

    // 一次确认两条 > 上限 1 → 整批 429，且一条都没被确认
    const tooMany = await json(`/agent/runs/${run.run.runId}/approve`, {
      method: 'POST',
      body: JSON.stringify({ intentIds: run.intents.map((i) => i.intentId) }),
    });
    expect(tooMany.status).toBe(429);
    expect(((await tooMany.json()) as { code: string }).code).toBe('AGENT_DAILY_SUBMIT_LIMIT_REACHED');
    expect(await repos.submitIntents.listByRunAndStatus(run.run.runId, 'approved')).toHaveLength(0);

    // 单条可确认；确认后任务离开人机闸进入 submitting（阶段 2），同一 run 不能再 approve
    const one = await json(`/agent/runs/${run.run.runId}/approve`, {
      method: 'POST',
      body: JSON.stringify({ intentIds: [run.intents[0]!.intentId] }),
    });
    expect(one.status).toBe(200);
    expect(((await one.json()) as { run: { status: string } }).run.status).toBe('submitting');

    // 额度按账号+源跨 run 累计：新 run 的票据再 approve → 429，且不被部分确认
    await repos.jobPostings.upsertBatch(
      [
        posting({
          sourceUrl: 'https://boards.example.com/acme/jobs/3',
          title: 'TypeScript Backend Engineer',
        }),
      ],
      POOL_SEEN_AT,
    );
    const run2Res = await json('/agent/runs', {
      method: 'POST',
      body: JSON.stringify({ preferenceId: preference.preferenceId, profileId: 'p-1' }),
    });
    const run2 = (await run2Res.json()) as {
      run: { runId: string };
      intents: Array<{ intentId: string; jobId: string }>;
    };
    // run2 是独立任务线：会重推 run1 已确认但未投递的岗位，加上 jobs/3 共 3 条
    expect(run2.intents).toHaveLength(3);
    const thirdJobId = makeJobPostingId('greenhouse', 'https://boards.example.com/acme/jobs/3');
    const thirdIntent = run2.intents.find((i) => i.jobId === thirdJobId);
    expect(thirdIntent).toBeDefined();
    const limited = await json(`/agent/runs/${run2.run.runId}/approve`, {
      method: 'POST',
      body: JSON.stringify({ intentIds: [thirdIntent!.intentId] }),
    });
    expect(limited.status).toBe(429);
    expect(((await limited.json()) as { code: string }).code).toBe('AGENT_DAILY_SUBMIT_LIMIT_REACHED');
    expect(await repos.submitIntents.listByRunAndStatus(run2.run.runId, 'approved')).toHaveLength(0);
  });

  it('serves the tailored resume and rule-based cover letter on demand', async () => {
    const { repos, json } = await harness();
    await insertProfile(repos, 'p-1', ALICE.login);
    await json('/profiles/p-1/claim', { method: 'POST' });
    await repos.jobPostings.upsertBatch([posting()], POOL_SEEN_AT);
    const prefRes = await json('/agent/preferences', { method: 'POST', body: JSON.stringify(PREFERENCE) });
    const { preference } = (await prefRes.json()) as { preference: { preferenceId: string } };
    const runRes = await json('/agent/runs', {
      method: 'POST',
      body: JSON.stringify({ preferenceId: preference.preferenceId, profileId: 'p-1' }),
    });
    const run = (await runRes.json()) as { intents: Array<{ intentId: string }> };
    const intentId = run.intents[0]!.intentId;

    const resume = await json(`/agent/intents/${intentId}/resume?format=md&locale=zh-CN`);
    expect(resume.status).toBe(200);
    const markdown = await resume.text();
    expect(markdown).toContain('Senior TypeScript Engineer');
    expect(markdown).toContain('TypeScript');

    const resumeJson = await json(`/agent/intents/${intentId}/resume?format=json`);
    const draft = (await resumeJson.json()) as { draft: { targetJob: { jobId: string }; matchedSkills: unknown[] } };
    expect(draft.draft.targetJob.jobId).toBe(makeJobPostingId('greenhouse', 'https://boards.example.com/acme/jobs/1'));
    expect(draft.draft.matchedSkills.length).toBeGreaterThan(0);

    const letter = await json(`/agent/intents/${intentId}/cover-letter?format=md`);
    expect(letter.status).toBe(200);
    const letterMd = await letter.text();
    expect(letterMd).toContain('Senior TypeScript Engineer');
    // no-fabrication：断言画像事实的段落必须挂证据
    const letterJson = await json(`/agent/intents/${intentId}/cover-letter?format=json&locale=en`);
    const letterDraft = (await letterJson.json()) as {
      draft: { paragraphs: Array<{ code: string; evidenceRefs: string[] }> };
    };
    for (const paragraph of letterDraft.draft.paragraphs) {
      if (paragraph.code === 'match' || paragraph.code === 'evidence') {
        expect(paragraph.evidenceRefs.length).toBeGreaterThan(0);
      }
    }

    expect((await json(`/agent/intents/${intentId}/resume?locale=de`)).status).toBe(400);
    expect((await json(`/agent/intents/${intentId}/cover-letter?format=pdf`)).status).toBe(400);
  });

  it('refuses to delete a preference that an active run still uses', async () => {
    const { repos, json } = await harness();
    await insertProfile(repos, 'p-1', ALICE.login);
    await json('/profiles/p-1/claim', { method: 'POST' });
    const prefRes = await json('/agent/preferences', {
      method: 'POST',
      body: JSON.stringify({ ...PREFERENCE, targetTitles: ['nothing-matches'] }),
    });
    const { preference } = (await prefRes.json()) as { preference: { preferenceId: string } };
    await json('/agent/runs', {
      method: 'POST',
      body: JSON.stringify({ preferenceId: preference.preferenceId, profileId: 'p-1' }),
    });

    const blocked = await json(`/agent/preferences/${preference.preferenceId}`, { method: 'DELETE' });
    expect(blocked.status).toBe(409);
    expect(((await blocked.json()) as { code: string }).code).toBe('AGENT_PREFERENCE_IN_USE');

    // 更新偏好（PUT）仍然可用
    const updated = await json(`/agent/preferences/${preference.preferenceId}`, {
      method: 'PUT',
      body: JSON.stringify({ label: '改过的名字' }),
    });
    expect(updated.status).toBe(200);
    expect(((await updated.json()) as { preference: { label: string } }).preference.label).toBe('改过的名字');
  });

  it('cancels a run and refuses to scan a terminal one', async () => {
    const { repos, json } = await harness();
    await insertProfile(repos, 'p-1', ALICE.login);
    await json('/profiles/p-1/claim', { method: 'POST' });
    const prefRes = await json('/agent/preferences', {
      method: 'POST',
      body: JSON.stringify({ ...PREFERENCE, targetTitles: ['nothing-matches'] }),
    });
    const { preference } = (await prefRes.json()) as { preference: { preferenceId: string } };
    const runRes = await json('/agent/runs', {
      method: 'POST',
      body: JSON.stringify({ preferenceId: preference.preferenceId, profileId: 'p-1' }),
    });
    const run = (await runRes.json()) as { run: { runId: string } };

    const cancelled = await json(`/agent/runs/${run.run.runId}/cancel`, { method: 'POST' });
    expect(cancelled.status).toBe(200);
    expect(((await cancelled.json()) as { run: { status: string } }).run.status).toBe('cancelled');

    const scan = await json(`/agent/runs/${run.run.runId}/scan`, { method: 'POST' });
    expect(scan.status).toBe(409);
    expect(((await scan.json()) as { code: string }).code).toBe('AGENT_RUN_NOT_ACTIVE');
    // 取消后偏好不再被活跃任务占用 → 可以删除
    const deleted = await json(`/agent/preferences/${preference.preferenceId}`, { method: 'DELETE' });
    expect(deleted.status).toBe(200);
  });

  it('flags a fresh awaiting_approval run as unseen and clears it after the owner views it', async () => {
    const { repos, json } = await harness();
    await insertProfile(repos, 'p-1', ALICE.login);
    await json('/profiles/p-1/claim', { method: 'POST' });
    await repos.jobPostings.upsertBatch([posting()], POOL_SEEN_AT);
    const prefRes = await json('/agent/preferences', {
      method: 'POST',
      body: JSON.stringify(PREFERENCE),
    });
    const { preference } = (await prefRes.json()) as { preference: { preferenceId: string } };
    const createRes = await json('/agent/runs', {
      method: 'POST',
      body: JSON.stringify({ preferenceId: preference.preferenceId, profileId: 'p-1' }),
    });
    const created = (await createRes.json()) as { run: { runId: string } };

    // 列表：刚扫出一批候选、从未查看 → 未读
    const listBefore = await json('/agent/runs');
    const listedBefore = (await listBefore.json()) as {
      runs: Array<{ runId: string; hasUnseenApprovals?: boolean }>;
    };
    expect(listedBefore.runs.find((r) => r.runId === created.run.runId)!.hasUnseenApprovals).toBe(true);

    // 显式已读：只写 last_viewed_at，不推进状态
    const runId = created.run.runId;
    const viewRes = await json(`/agent/runs/${runId}/view`, { method: 'POST' });
    expect(viewRes.status).toBe(200);
    const viewed = (await viewRes.json()) as {
      run: { status: string; hasUnseenApprovals: boolean; lastViewedAt: string | null };
    };
    expect(viewed.run.status).toBe('awaiting_approval');
    expect(viewed.run.hasUnseenApprovals).toBe(false);
    expect(viewed.run.lastViewedAt).toBeTruthy();

    // 再读列表：派生标记已消
    const listAfter = await json('/agent/runs');
    const listedAfter = (await listAfter.json()) as {
      runs: Array<{ runId: string; hasUnseenApprovals?: boolean }>;
    };
    expect(listedAfter.runs.find((r) => r.runId === runId)!.hasUnseenApprovals).toBe(false);

    // 别人的 run 看不到：404（归属闸）
    const other = await harness();
    const forOwn = await other.json(`/agent/runs/${runId}/view`, { method: 'POST' });
    expect(forOwn.status).toBe(404);
  });
});

describe('agent workbench — cron tick', () => {
  it('requires the cron secret and advances queued runs', async () => {
    const { repos, app, json } = await harness();
    await insertProfile(repos, 'p-1', ALICE.login);
    await json('/profiles/p-1/claim', { method: 'POST' });
    await repos.jobPostings.upsertBatch([posting()], POOL_SEEN_AT);
    // 先建一套「扫不到东西」的偏好：创建任务后停在 watching（等下一轮），pending 为空
    const prefRes = await json('/agent/preferences', {
      method: 'POST',
      body: JSON.stringify({ ...PREFERENCE, targetTitles: ['nothing-matches'] }),
    });
    const { preference } = (await prefRes.json()) as { preference: { preferenceId: string } };
    const runRes = await json('/agent/runs', {
      method: 'POST',
      body: JSON.stringify({ preferenceId: preference.preferenceId, profileId: 'p-1' }),
    });
    const run = (await runRes.json()) as { run: { runId: string; status: string } };
    expect(run.run.status).toBe('watching');

    const unauthorized = await app.request('/internal/cron/agent-tick');
    expect(unauthorized.status).toBe(401);

    // 用户把偏好改成能命中的关键词后，cron tick 负责把任务重新扫一轮（工作台的日更调度）
    const patched = await json(`/agent/preferences/${preference.preferenceId}`, {
      method: 'PUT',
      body: JSON.stringify({ targetTitles: PREFERENCE.targetTitles }),
    });
    expect(patched.status).toBe(200);

    const tick = await app.request('/internal/cron/agent-tick', {
      headers: { authorization: `Bearer ${CRON_SECRET}` },
    });
    expect(tick.status).toBe(200);
    const body = (await tick.json()) as {
      ok: boolean;
      outcome: { advanced: number; idle: boolean; results: Array<{ runId: string; status: string }> };
    };
    expect(body.ok).toBe(true);
    expect(body.outcome.results.map((r) => r.runId)).toContain(run.run.runId);
    expect(body.outcome.results.find((r) => r.runId === run.run.runId)?.status).toBe(
      'awaiting_approval',
    );
    const view = (await (await json(`/agent/runs/${run.run.runId}`)).json()) as {
      run: { status: string };
      intents: unknown[];
    };
    expect(view.run.status).toBe('awaiting_approval');
    expect(view.intents).toHaveLength(1);

    // 队列清空后 tick 是幂等的 idle
    const idle = await app.request('/internal/cron/agent-tick', {
      headers: { authorization: `Bearer ${CRON_SECRET}` },
    });
    expect(((await idle.json()) as { outcome: { idle: boolean } }).outcome.idle).toBe(true);
  });

  it('recycles stale submitting runs to failed with an explicit submit_timeout reason on tick', async () => {
    const { repos, app, json } = await harness();
    await insertProfile(repos, 'p-1', ALICE.login);
    await json('/profiles/p-1/claim', { method: 'POST' });
    await repos.jobPostings.upsertBatch([posting()], POOL_SEEN_AT);
    const prefRes = await json('/agent/preferences', { method: 'POST', body: JSON.stringify(PREFERENCE) });
    const { preference } = (await prefRes.json()) as { preference: { preferenceId: string } };
    const runRes = await json('/agent/runs', {
      method: 'POST',
      body: JSON.stringify({ preferenceId: preference.preferenceId, profileId: 'p-1' }),
    });
    const run = (await runRes.json()) as {
      run: { runId: string };
      intents: Array<{ intentId: string }>;
    };
    const approveRes = await json(`/agent/runs/${run.run.runId}/approve`, {
      method: 'POST',
      body: JSON.stringify({ intentIds: [run.intents[0]!.intentId] }),
    });
    expect(approveRes.status).toBe(200);
    expect(((await approveRes.json()) as { run: { status: string } }).run.status).toBe('submitting');

    // 模拟用户确认后 48h 未在扩展完成提交：把 run 的 updatedAt 拨回过去
    const stale = new Date(Date.now() - 48 * 3_600_000).toISOString();
    await repos.jobRuns.setStatus(run.run.runId, { status: 'submitting', updatedAt: stale });

    const tick = await app.request('/internal/cron/agent-tick', {
      headers: { authorization: `Bearer ${CRON_SECRET}` },
    });
    expect(tick.status).toBe(200);
    const body = (await tick.json()) as { ok: boolean; outcome: { recycled: number } };
    expect(body.ok).toBe(true);
    expect(body.outcome.recycled).toBe(1);

    const view = (await (await json(`/agent/runs/${run.run.runId}`)).json()) as {
      run: { status: string; lastError: string | null };
      events: Array<{ event: string; actor: string; fromStatus: string; toStatus: string }>;
    };
    expect(view.run.status).toBe('failed');
    expect(view.run.lastError).toBe('submit_timeout');
    expect(view.events.at(-1)).toMatchObject({
      event: 'fail',
      actor: 'system',
      fromStatus: 'submitting',
      toStatus: 'failed',
    });
  });

  it('recovers a run stuck in recommending past the stale threshold via system rescan on tick', async () => {
    const { repos, app, json } = await harness();
    await insertProfile(repos, 'p-1', ALICE.login);
    await json('/profiles/p-1/claim', { method: 'POST' });
    await repos.jobPostings.upsertBatch([posting()], POOL_SEEN_AT);
    const prefRes = await json('/agent/preferences', { method: 'POST', body: JSON.stringify(PREFERENCE) });
    const { preference } = (await prefRes.json()) as { preference: { preferenceId: string } };
    const runRes = await json('/agent/runs', {
      method: 'POST',
      body: JSON.stringify({ preferenceId: preference.preferenceId, profileId: 'p-1' }),
    });
    const run = (await runRes.json()) as { run: { runId: string } };

    // 模拟占位进程在写票据前被杀：拨到 recommending 并把 updatedAt 退回 20 分钟前
    const stale = new Date(Date.now() - 20 * 60_000).toISOString();
    await repos.jobRuns.setStatus(run.run.runId, { status: 'recommending', updatedAt: stale });

    const tick = await app.request('/internal/cron/agent-tick', {
      headers: { authorization: `Bearer ${CRON_SECRET}` },
    });
    expect(tick.status).toBe(200);
    const body = (await tick.json()) as { ok: boolean; outcome: { recycled: number } };
    expect(body.ok).toBe(true);
    expect(body.outcome.recycled).toBe(1);

    const view = (await (await json(`/agent/runs/${run.run.runId}`)).json()) as {
      run: { status: string };
      events: Array<{ event: string; actor: string; fromStatus: string; toStatus: string }>;
    };
    // 回收走状态机既有的 recommending --rescan--> watching 出边（system 动作、可审计）
    expect(view.events).toContainEqual(
      expect.objectContaining({
        event: 'rescan',
        actor: 'system',
        fromStatus: 'recommending',
        toStatus: 'watching',
      }),
    );
    // 回收后同一 tick 立即重扫：唯一条岗位已有票据被排除，本轮无新候选，留在 watching
    expect(view.run.status).toBe('watching');
  });
});

describe('agent stage 2 — extension pending-fills, outcome write-back, LLM polish fallback', () => {
  /** 建画像→认领→灌岗位→偏好→建 run（即扫一轮落 1 张 pending 票据），返回 run/intent 句柄。 */
  async function preparedRun(h: Awaited<ReturnType<typeof harness>>) {
    const { repos, json } = h;
    await insertProfile(repos, 'p-1', ALICE.login);
    await json('/profiles/p-1/claim', { method: 'POST' });
    await repos.jobPostings.upsertBatch([posting()], POOL_SEEN_AT);
    const prefRes = await json('/agent/preferences', { method: 'POST', body: JSON.stringify(PREFERENCE) });
    const { preference } = (await prefRes.json()) as { preference: { preferenceId: string } };
    const runRes = await json('/agent/runs', {
      method: 'POST',
      body: JSON.stringify({ preferenceId: preference.preferenceId, profileId: 'p-1' }),
    });
    const run = (await runRes.json()) as { run: { runId: string }; intents: Array<{ intentId: string }> };
    return { runId: run.run.runId, intentId: run.intents[0]!.intentId };
  }

  it('lists approved intents as pending fills and removes them after mark-submitted', async () => {
    const h = await harness();
    const { json } = h;
    const { runId, intentId } = await preparedRun(h);

    // approve 前：没有待填充
    const empty = await json('/agent/extension/pending-fills');
    expect(empty.status).toBe(200);
    expect((await empty.json()) as { fills: unknown[] }).toEqual({ fills: [] });

    const approve = await json(`/agent/runs/${runId}/approve`, {
      method: 'POST',
      body: JSON.stringify({ intentIds: [intentId] }),
    });
    expect(approve.status).toBe(200);

    const fillsRes = await json('/agent/extension/pending-fills');
    expect(fillsRes.status).toBe(200);
    const fillsBody = (await fillsRes.json()) as {
      fills: Array<{ intentId: string; job: { sourceUrl: string }; matchTier: string; approvedAt: string }>;
    };
    expect(fillsBody.fills).toHaveLength(1);
    expect(fillsBody.fills[0]).toMatchObject({
      intentId,
      matchTier: 'high',
    });
    expect(fillsBody.fills[0]!.job.sourceUrl).toBe('https://boards.example.com/acme/jobs/1');
    expect(new Date(fillsBody.fills[0]!.approvedAt).getTime()).not.toBeNaN();

    // 用户提交后回执：票据转 submitted，不再出现在待填充列表
    const marked = await json(`/agent/intents/${intentId}/mark-submitted`, { method: 'POST' });
    expect(marked.status).toBe(200);
    const after = (await (await json('/agent/extension/pending-fills')).json()) as { fills: unknown[] };
    expect(after.fills).toHaveLength(0);
  });

  it('records outcome feedback only after submission and validates the enum', async () => {
    const h = await harness();
    const { repos, json } = h;
    const { runId, intentId } = await preparedRun(h);
    await json(`/agent/runs/${runId}/approve`, {
      method: 'POST',
      body: JSON.stringify({ intentIds: [intentId] }),
    });

    // 仅 approved、未回执：没有 application，409
    const tooEarly = await json(`/agent/intents/${intentId}/outcome`, {
      method: 'POST',
      body: JSON.stringify({ outcome: 'offer' }),
    });
    expect(tooEarly.status).toBe(409);

    const marked = (await (
      await json(`/agent/intents/${intentId}/mark-submitted`, { method: 'POST' })
    ).json()) as { applicationId: string };

    // 非法枚举 400
    const bad = await json(`/agent/intents/${intentId}/outcome`, {
      method: 'POST',
      body: JSON.stringify({ outcome: 'ghosted' }),
    });
    expect(bad.status).toBe(400);

    const ok = await json(`/agent/intents/${intentId}/outcome`, {
      method: 'POST',
      body: JSON.stringify({ outcome: 'interview', note: 'recruiter screen booked' }),
    });
    expect(ok.status).toBe(200);
    const okBody = (await ok.json()) as { outcomeFeedback: string; outcomeFeedbackAt: string };
    expect(okBody.outcomeFeedback).toBe('interview');
    expect(new Date(okBody.outcomeFeedbackAt).getTime()).not.toBeNaN();

    const app = await repos.applications.getById(marked.applicationId);
    expect(app?.outcomeFeedback).toBe('interview');
    expect(app?.outcomeFeedbackAt).toBeTruthy();
  });

  it('gracefully falls back to the rule-based cover letter when no LLM is configured', async () => {
    const h = await harness();
    const { runId, intentId } = await preparedRun(h);
    const res = await h.json(`/agent/intents/${intentId}/cover-letter?format=json&polish=llm`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      polished: boolean;
      fallbackReason: string;
      body: string;
      subject: string | null;
    };
    expect(body.polished).toBe(false);
    expect(body.fallbackReason).toBe('llm_unavailable');
    expect(body.subject).toBeNull();
    expect(body.body.length).toBeGreaterThan(20);
    void runId;
  });
});

describe('agent workbench — event stream paging', () => {
  type Harness = Awaited<ReturnType<typeof harness>>;

  /** 建一个跑过一轮的任务，并补写一批历史事件。返回 runId 与补写的同刻那组 id。 */
  async function seededRun(repos: Harness['repos'], json: Harness['json']) {
    await insertProfile(repos, 'p-page', ALICE.login);
    expect((await json('/profiles/p-page/claim', { method: 'POST' })).status).toBe(200);
    await repos.jobPostings.upsertBatch([posting()], POOL_SEEN_AT);
    const prefRes = await json('/agent/preferences', {
      method: 'POST',
      body: JSON.stringify(PREFERENCE),
    });
    const { preference } = (await prefRes.json()) as { preference: { preferenceId: string } };
    const runRes = await json('/agent/runs', {
      method: 'POST',
      body: JSON.stringify({ preferenceId: preference.preferenceId, profileId: 'p-page' }),
    });
    const { run } = (await runRes.json()) as { run: { runId: string } };

    // 三条共用同一时刻的自迁移＝"一次 tick 落多条"的真实形状：时间戳游标会把它们从中间切断
    const base = Date.parse('2026-10-04T00:00:00.000Z');
    const tied = [
      { id: 'evt-t0', at: base },
      { id: 'evt-t1', at: base },
      { id: 'evt-t2', at: base },
      { id: 'evt-later', at: base + 60_000 },
    ];
    for (const e of tied) {
      await repos.jobRunEvents.insert({
        id: e.id,
        runId: run.runId,
        event: 'rescan',
        fromStatus: 'watching',
        toStatus: 'watching',
        actor: 'agent',
        createdAt: new Date(e.at).toISOString(),
      });
    }
    return { runId: run.runId, tied: tied.filter((e) => e.at === base).map((e) => e.id) };
  }

  it('reports whether the run view truncated the stream, truthfully', async () => {
    const { repos, json } = await harness();
    const { runId } = await seededRun(repos, json);

    const view = (await (await json(`/agent/runs/${runId}`)).json()) as {
      events: Array<{ eventId: string }>;
      eventsHasMore: boolean;
    };
    // 8 条远不到 200 的窗口 ⇒ 如实报"没有更早的"，不给一个空转的按钮
    expect(view.events.length).toBeLessThan(200);
    expect(view.eventsHasMore).toBe(false);

    // 游标端点第一页同样据实回答
    const first = (await (await json(`/agent/runs/${runId}/events?limit=3`)).json()) as {
      events: Array<{ eventId: string }>;
      hasMore: boolean;
    };
    expect(first.events).toHaveLength(3);
    expect(first.hasMore).toBe(true);
  });

  it('walks the whole stream backwards without losing or repeating an event', async () => {
    const { repos, json } = await harness();
    const { runId, tied } = await seededRun(repos, json);

    const view = (await (await json(`/agent/runs/${runId}`)).json()) as {
      events: Array<{ eventId: string }>;
    };
    const full = view.events.map((e) => e.eventId);

    const walked: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 20; guard += 1) {
      const res = await json(
        `/agent/runs/${runId}/events?limit=2${cursor ? `&before=${cursor}` : ''}`,
      );
      expect(res.status).toBe(200);
      const page = (await res.json()) as {
        events: Array<{ eventId: string }>;
        hasMore: boolean;
      };
      expect(page.events.length).toBeGreaterThan(0);
      walked.unshift(...page.events.map((e) => e.eventId));
      if (!page.hasMore) break;
      cursor = page.events[0]!.eventId;
    }

    // 逐页接起来必须与整条流逐字节一致：不重、不漏、顺序不变
    expect(walked).toEqual(full);
    // 同刻那一组必须整段连续出现（被切断就会在这里露出来）
    const positions = tied.map((id) => walked.indexOf(id));
    expect(positions.sort((a, b) => a - b)).toEqual([
      positions[0]!,
      positions[0]! + 1,
      positions[0]! + 2,
    ]);
  });

  it('rejects a cursor that is not part of this run instead of claiming the stream ended', async () => {
    const { repos, json } = await harness();
    const { runId } = await seededRun(repos, json);

    const bad = await json(`/agent/runs/${runId}/events?before=evt-never-existed`);
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { code: string }).code).toBe('AGENT_EVENT_CURSOR_INVALID');

    // 别的 run 的真实事件 id 也不能当本 run 的游标
    const foreign = await json(`/agent/runs/${runId}/events?before=evt-1`);
    expect(foreign.status).toBe(400);

    // limit 越界与非法参数一律 400（不是静默按默认值跑）
    for (const q of ['limit=0', 'limit=9999', 'limit=abc', 'unknown=1']) {
      const res = await json(`/agent/runs/${runId}/events?${q}`);
      expect(res.status, q).toBe(400);
    }
  });
});

describe('agent workbench — C1 LLM JD extraction (fail-closed)', () => {
  /** 起内存库 + 已登录 Alice，并注入带 jdExtractor 的 AgentConfig。 */
  async function harnessWithJd(
    jdExtractor: JdExtractor,
    configOverride: Partial<ReturnType<typeof loadAgentConfig>> = {},
  ) {
    const repos = await createStorage({ sqlitePath: ':memory:' });
    const { Cookie } = await loginUser(repos, ALICE);
    const app = await createApp({
      repos,
      authConfig: loadAuthConfig({}),
      githubAuthProvider: new FakeAuthProvider(ALICE),
      agentConfig: { ...loadAgentConfig(), ...configOverride, jdExtractor },
    });
    const json = (path: string, init: RequestInit = {}) =>
      app.request(path, {
        ...init,
        headers: { 'Content-Type': 'application/json', Cookie, ...(init.headers ?? {}) },
      });
    return { repos, json };
  }

  /** 认领画像 + 岗位池一条岗位 + 偏好 + 建 run，返回首扫响应里的票据。 */
  async function scanOnce(json: Awaited<ReturnType<typeof harnessWithJd>>['json'], repos: StorageContext) {
    await insertProfile(repos, 'p-c1', ALICE.login);
    const claim = await json('/profiles/p-c1/claim', { method: 'POST' });
    expect(claim.status).toBe(200);
    await repos.jobPostings.upsertBatch([posting()], POOL_SEEN_AT);
    const prefRes = await json('/agent/preferences', { method: 'POST', body: JSON.stringify(PREFERENCE) });
    const { preference } = (await prefRes.json()) as { preference: { preferenceId: string } };
    const runRes = await json('/agent/runs', {
      method: 'POST',
      body: JSON.stringify({ preferenceId: preference.preferenceId, profileId: 'p-c1' }),
    });
    expect(runRes.status).toBe(201);
    return (await runRes.json()) as {
      run: { status: string };
      events: Array<{ event: string }>;
      intents: Array<{
        matchTier: string;
        report: {
          score: number;
          tier: string;
          jdInsight?: unknown;
          gaps: Array<{ code: string; tag: string }>;
        };
      }>;
    };
  }

  it('keeps the pure-rule report and still reaches the approval gate when the LLM throws', async () => {
    const extractor: JdExtractor = async () => {
      throw new Error('llm down');
    };
    const { repos, json } = await harnessWithJd(extractor);
    const body = await scanOnce(json, repos);

    expect(body.run.status).toBe('awaiting_approval');
    expect(body.events.map((e) => e.event)).toContain('generated');
    const report = body.intents[0]!.report;
    expect(report.jdInsight).toBeUndefined();
    // 失败时不产生语义缺口，只剩规则缺口（node 画像无证据）
    expect(report.gaps.every((g) => g.code === 'tag_not_in_profile')).toBe(true);
  });

  it('merges LLM-extracted JD requirements into gaps without changing score/tier', async () => {
    const seen: Array<{ title: string; description: string }> = [];
    const extractor: JdExtractor = async (title, description) => {
      seen.push({ title, description });
      return {
        responsibilities: ['Build backend services'],
        requiredSkills: ['Rust'],
        qualifications: ['5+ years experience'],
      };
    };
    const { repos, json } = await harnessWithJd(extractor);
    const body = await scanOnce(json, repos);

    // extractor 收到真实标题与 JD 正文
    expect(seen[0]?.title).toBe('Senior TypeScript Engineer');
    expect(seen[0]?.description).toBe('Build TypeScript services.');

    const report = body.intents[0]!.report;
    expect(report.jdInsight).toEqual({
      responsibilities: ['Build backend services'],
      requiredSkills: ['Rust'],
      qualifications: ['5+ years experience'],
    });
    // 规则缺口（node）在前，语义缺口（Rust）在后；资历/职责不产缺口
    expect(report.gaps.map((g) => g.code)).toEqual([
      'tag_not_in_profile',
      'jd_requirement_not_in_profile',
    ]);
    expect(report.gaps.map((g) => g.tag)).toEqual(['node', 'Rust']);
    // 档位仍由规则决定
    expect(report.tier).toBe('high');
  });

  it('spends at most the JD LLM wall-clock budget and still writes intents for all ready candidates', async () => {
    const seen: string[] = [];
    // 每条调用耗时 60ms；预算 100ms ⇒ 第 1、2 条调用（t≈0/60）放行，第 3 条在 t≈120
    // 被预算挡住。3 条候选都必须写出票据，只是最后一条没有 jdInsight。
    const extractor: JdExtractor = async (title) => {
      seen.push(title);
      await new Promise((resolve) => setTimeout(resolve, 60));
      return { responsibilities: [], requiredSkills: ['Rust'], qualifications: [] };
    };
    const { repos, json } = await harnessWithJd(extractor, { jdLlmBudgetMs: 100 });
    await insertProfile(repos, 'p-c1', ALICE.login);
    expect((await json('/profiles/p-c1/claim', { method: 'POST' })).status).toBe(200);
    await repos.jobPostings.upsertBatch(
      [
        posting(),
        posting({
          sourceUrl: 'https://boards.example.com/acme/jobs/2',
          normalizedKey: 'acme-senior-typescript-engineer-2',
        }),
        posting({
          sourceUrl: 'https://boards.example.com/acme/jobs/3',
          normalizedKey: 'acme-senior-typescript-engineer-3',
        }),
      ],
      POOL_SEEN_AT,
    );
    const prefRes = await json('/agent/preferences', { method: 'POST', body: JSON.stringify(PREFERENCE) });
    const { preference } = (await prefRes.json()) as { preference: { preferenceId: string } };
    const runRes = await json('/agent/runs', {
      method: 'POST',
      body: JSON.stringify({ preferenceId: preference.preferenceId, profileId: 'p-c1' }),
    });
    expect(runRes.status).toBe(201);
    const body = (await runRes.json()) as {
      run: { status: string };
      intents: Array<{ report: { jdInsight?: unknown } }>;
    };

    expect(body.run.status).toBe('awaiting_approval');
    expect(body.intents).toHaveLength(3);
    expect(seen).toHaveLength(2);
    expect(body.intents.filter((i) => i.report.jdInsight)).toHaveLength(2);
    expect(body.intents.filter((i) => !i.report.jdInsight)).toHaveLength(1);
  });
});

/**
 * 质量闸的可见面（C 端体验增量）：闸挡下一条岗位必须说得出**为什么**，
 * 否则用户无法区分"池子里没有"与"被我的阈值挡了"，也就无从调整。
 *
 * 分数口径：一个命中技能满分 6（title 3 / tags 2 / description 1），画像只有 TypeScript，
 * 所以四条夹具分别落在 high / high（靠发布时间排序落选）/ low（仅标签命中）/ 仅描述命中。
 */
describe('agent workbench — gate exclusions are visible', () => {
  const CHOSEN = posting({
    sourceUrl: 'https://boards.example.com/acme/jobs/chosen',
    postedAt: '2026-10-03T00:00:00.000Z',
  });
  // 同样合格、但本轮没轮到它出票：它既不是票据，也不算"被闸挡下"
  const NEXT_PICK = posting({
    sourceUrl: 'https://boards.example.com/acme/jobs/next-pick',
    postedAt: '2026-10-02T00:00:00.000Z',
  });
  const RUNNER_UP = posting({
    sourceUrl: 'https://boards.example.com/acme/jobs/runner-up',
    postedAt: '2026-10-01T00:00:00.000Z',
  });
  // 标题不含技能、标签含：过得了守卫但分档只有 low
  const BELOW_TIER = posting({
    sourceUrl: 'https://boards.example.com/acme/jobs/below',
    title: 'Data Engineer',
    tags: ['typescript', 'airflow'],
    description: 'Pipelines.',
  });
  // 只有描述提到技能：规则 0.2 的守卫直接挡下（哪怕分数够）
  const DESCRIPTION_ONLY = posting({
    sourceUrl: 'https://boards.example.com/acme/jobs/desc-only',
    title: 'Backend Engineer',
    tags: ['go'],
    description: 'Uses TypeScript in the core.',
  });

  async function harness(
    rows: NewJobPosting[],
    configOverride: Partial<ReturnType<typeof loadAgentConfig>> = {},
  ) {
    const repos = await createStorage({ sqlitePath: ':memory:' });
    const { Cookie } = await loginUser(repos, ALICE);
    const app = await createApp({
      repos,
      authConfig: loadAuthConfig({}),
      githubAuthProvider: new FakeAuthProvider(ALICE),
      agentConfig: { ...loadAgentConfig(), ...configOverride },
    });
    const json = (path: string, init: RequestInit = {}) =>
      app.request(path, {
        ...init,
        headers: { 'Content-Type': 'application/json', Cookie, ...(init.headers ?? {}) },
      });
    await insertProfile(repos, 'p-gate', ALICE.login);
    await json('/profiles/p-gate/claim', { method: 'POST' });
    if (rows.length > 0) await repos.jobPostings.upsertBatch(rows, POOL_SEEN_AT);
    const prefRes = await json('/agent/preferences', {
      method: 'POST',
      body: JSON.stringify({ ...PREFERENCE, targetTitles: ['engineer'] }),
    });
    const { preference } = (await prefRes.json()) as { preference: { preferenceId: string } };
    const preferenceId = preference.preferenceId;
    const runRes = await json('/agent/runs', {
      method: 'POST',
      body: JSON.stringify({ preferenceId: preference.preferenceId, profileId: 'p-gate' }),
    });
    expect(runRes.status).toBe(201);
    const created = (await runRes.json()) as {
      run: { runId: string; status: string };
      intents: Array<{ intentId: string; jobId: string }>;
    };
    const exclusions = async () => {
      const res = await json(`/agent/runs/${created.run.runId}/gate-exclusions`);
      expect(res.status).toBe(200);
      return (await res.json()) as {
        runId: string;
        status: string;
        minTier: string;
        poolSize: number;
        matchedCount: number;
        items: Array<{
          postingId: string;
          jobId: string;
          title: string;
          score: number;
          tier: string;
          reason: string;
        }>;
      };
    };
    return { repos, app, json, Cookie, created, preferenceId, exclusions };
  }

  it('names the gate that blocked each candidate, in the same ranking order as the picks', async () => {
    const { created, exclusions } = await harness(
      [CHOSEN, NEXT_PICK, RUNNER_UP, BELOW_TIER, DESCRIPTION_ONLY],
      { candidateLimit: 1 },
    );
    expect(created.intents.map((i) => i.jobId)).toEqual([CHOSEN.jobId]);

    const body = await exclusions();
    expect(body.minTier).toBe('mid');
    expect(body.poolSize).toBe(5);
    expect(body.matchedCount).toBe(5);
    // 名次与 selected 用同一把尺：分数相同看发布时间，所以"差一点的就排在差很多的前面"
    expect(body.items.map((i) => [i.jobId, i.reason, i.tier])).toEqual([
      [RUNNER_UP.jobId, 'over_candidate_limit', 'high'],
      [BELOW_TIER.jobId, 'below_min_tier', 'low'],
      [DESCRIPTION_ONLY.jobId, 'no_title_or_tag_hit', 'low'],
    ]);
    // 过了闸、只是本轮没轮到出票的那条，两个清单都不属于它——
    // 把它标成"被挡下"会让用户以为放宽阈值就能拿到，其实下一轮扫描自然会给它票据。
    const ids = body.items.map((i) => i.jobId);
    expect(ids).not.toContain(NEXT_PICK.jobId);
    expect(created.intents.map((i) => i.jobId)).not.toContain(NEXT_PICK.jobId);
    // 描述命中那条只有 1 分（分档 low），但原因码必须是守卫，不是"分档不够"
    expect(body.items[2]!.score).toBe(1);
  });

  it('never lists a job that already has a ticket, and a rejected one stays out too', async () => {
    const { json, created, exclusions } = await harness([CHOSEN, BELOW_TIER, DESCRIPTION_ONLY]);
    // 默认名额下 CHOSEN 已变成票据
    expect(created.intents.map((i) => i.jobId)).toEqual([CHOSEN.jobId]);

    let body = await exclusions();
    expect(body.items.map((i) => i.jobId)).toEqual([BELOW_TIER.jobId, DESCRIPTION_ONLY.jobId]);

    // 拒绝那张票据之后，它仍不属于"被闸挡下"——那是去重口径，放宽阈值拿不回来
    const reject = await json(`/agent/runs/${created.run.runId}/reject`, {
      method: 'POST',
      body: JSON.stringify({ intentId: created.intents[0]!.intentId, reason: '已投递过' }),
    });
    expect(reject.status).toBe(200);
    body = await exclusions();
    expect(body.items.map((i) => i.jobId)).toEqual([BELOW_TIER.jobId, DESCRIPTION_ONLY.jobId]);
  });

  it('accounts for every matched job: tickets + blocked = matched, nothing silently dropped', async () => {
    const { created, exclusions } = await harness([
      CHOSEN,
      NEXT_PICK,
      RUNNER_UP,
      BELOW_TIER,
      DESCRIPTION_ONLY,
    ]);
    const body = await exclusions();
    expect(created.intents).toHaveLength(3);
    expect(created.intents.length + body.items.length).toBe(body.matchedCount);
  });

  it('fails loudly instead of pretending the pool was empty', async () => {
    const { repos, json, created, preferenceId, exclusions } = await harness([CHOSEN, BELOW_TIER]);
    expect((await exclusions()).items).toHaveLength(1);

    // 偏好行没了：派生不出任何口径，必须报错，不能回空列表（空列表＝"池子里确实没被挡的"）
    await repos.jobPreferences.delete(preferenceId);
    const res = await json(`/agent/runs/${created.run.runId}/gate-exclusions`);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe('AGENT_PREFERENCE_NOT_FOUND');
  });

  it('gates the read like every other agent surface: 401 anonymous, 404 foreign run', async () => {
    const { app, repos, json, created } = await harness([CHOSEN, BELOW_TIER]);
    const anonymous = await app.request(`/agent/runs/${created.run.runId}/gate-exclusions`);
    expect(anonymous.status).toBe(401);

    const bob = await loginUser(repos, BOB);
    const foreign = await app.request(`/agent/runs/${created.run.runId}/gate-exclusions`, {
      headers: { Cookie: bob.Cookie },
    });
    expect(foreign.status).toBe(404);

    // 终态任务没有闸可看（清单已冻结），409 而不是空列表
    const cancel = await json(`/agent/runs/${created.run.runId}/cancel`, { method: 'POST' });
    expect(cancel.status).toBe(200);
    const cancelled = await json(`/agent/runs/${created.run.runId}/gate-exclusions`);
    expect(cancelled.status).toBe(409);
    expect(((await cancelled.json()) as { code: string }).code).toBe('AGENT_RUN_NOT_ACTIVE');
  });
});
