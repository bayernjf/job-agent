/**
 * API 集成测试（M1·W3）：
 * - POST /analyze：创建任务、去重、输入校验
 * - GET /jobs/:id：查询任务状态、不存在
 * - GET /profiles/:id：查询画像、不存在
 * - GET /health：健康检查
 *
 * 全部用内存数据库 + createStorage 仓储注入 createApp，Hono app.request() 测试，不启动服务器。
 */

import { describe, expect, it } from 'vitest';
import type { AbilityProfile } from '@jobagent/shared';
import { createStorage, type StorageContext } from '@jobagent/storage';
import { createApp } from './index.js';

async function freshRepos(): Promise<StorageContext> {
  return createStorage({ sqlitePath: ':memory:' });
}

/** 直接在仓储层建一个有效演示会话，返回可放进请求头的 Cookie 字符串。 */
async function demoSessionCookie(
  repos: StorageContext,
  id = 'demo-test-session',
): Promise<string> {
  await repos.demoSessions.create({
    id,
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    ipHash: null,
  });
  return `jobagent_demo=${id}`;
}

/** 带 demo Cookie 的 JSON 请求头。 */
function demoJsonHeaders(cookie: string): Record<string, string> {
  return { 'Content-Type': 'application/json', Cookie: cookie };
}

function sampleProfile(profileId: string, login = 'test-user'): AbilityProfile {
  return {
    profileId,
    analyzerVersion: 'schema-0.1-engine-0.1.0',
    generatedAt: '2026-09-11T00:00:00.000Z',
    dataWindow: { since: '2025-09-11T00:00:00.000Z', until: '2026-09-11T00:00:00.000Z' },
    analysisLayers: ['L0', 'L1'],
    subject: {
      platform: 'github',
      login,
      profileUrl: `https://github.com/${login}`,
      claimed: false,
    },
    summary: { headline: 'Test developer' },
    skillTags: [],
    activity: { longevityMonths: 12 },
    collaboration: { evidenceRefs: [] },
    authenticity: {
      status: 'likely_authentic',
      confidence: 0.75,
      signals: [],
    },
    interviewQuestions: [],
    caveats: [],
  };
}

describe('GET /health', () => {
  it('returns ok status', async () => {
    const app = await createApp({ repos: await freshRepos() });
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.status).toBe('ok');
    expect(body.service).toBe('jobagent-api');
  });

  it('shallow check does not touch the database (no db field)', async () => {
    const app = await createApp({ repos: await freshRepos() });
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.db).toBeUndefined();
    expect(body.dbLatencyMs).toBeUndefined();
  });

  it('deep check reports db ok when the database round-trip succeeds', async () => {
    const app = await createApp({ repos: await freshRepos() });
    for (const qs of ['?deep=1', '?deep=true']) {
      const res = await app.request(`/health${qs}`);
      expect(res.status, qs).toBe(200);
      const body = await res.json() as any;
      expect(body.status, qs).toBe('ok');
      expect(body.db, qs).toBe('ok');
      expect(body.dbLatencyMs, qs).toEqual(expect.any(Number));
    }
  });

  it('deep check returns 503 with db unreachable when the database ping fails', async () => {
    const repos = await freshRepos();
    const app = await createApp({
      repos: { ...repos, ping: async () => { throw new Error('connection refused'); } },
    });
    const res = await app.request('/health?deep=1');
    expect(res.status).toBe(503);
    const body = await res.json() as any;
    expect(body.status).toBe('error');
    expect(body.db).toBe('unreachable');
    expect(body.error).toContain('connection refused');
  });
});

describe('POST /analyze', () => {
  it('creates a new analysis job and returns jobId', async () => {
    const repos = await freshRepos();
    const app = await createApp({ repos });
    const cookie = await demoSessionCookie(repos);

    const res = await app.request('/analyze', {
      method: 'POST',
      headers: demoJsonHeaders(cookie),
      body: JSON.stringify({ username: 'test-user' }),
    });

    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.jobId).toBeTruthy();
    expect(body.jobId).toMatch(/^job-/);
    expect(body.status).toBe('queued');
    expect(body.dedup).toBe(false);
    expect(body.demo.remaining).toBe(2);

    // 任务确实被创建，且标记为 demo 请求者
    const job = await repos.jobs.getById(body.jobId);
    expect(job).toBeDefined();
    expect(job!.subjectLogin).toBe('test-user');
    expect(job!.status).toBe('queued');
    expect(job!.requesterKind).toBe('demo');
    expect(job!.demoSessionId).toBe('demo-test-session');
  });

  it('returns existing jobId when user has an active job (dedup)', async () => {
    const repos = await freshRepos();
    const app = await createApp({ repos });
    const cookie = await demoSessionCookie(repos);

    // 第一次创建
    const res1 = await app.request('/analyze', {
      method: 'POST',
      headers: demoJsonHeaders(cookie),
      body: JSON.stringify({ username: 'dedup-user' }),
    });
    const body1 = await res1.json() as any;

    // 第二次创建（同一用户，应该去重，且不额外扣会话名额）
    const res2 = await app.request('/analyze', {
      method: 'POST',
      headers: demoJsonHeaders(cookie),
      body: JSON.stringify({ username: 'dedup-user' }),
    });

    expect(res2.status).toBe(200);
    const body2 = await res2.json() as any;
    expect(body2.jobId).toBe(body1.jobId);
    expect(body2.dedup).toBe(true);

    // 队列中仍然只有一个任务
    const queued = await repos.jobs.listQueued();
    expect(queued).toHaveLength(1);
    expect(queued[0]!.id).toBe(body1.jobId);

    // 去重不扣配额：analyze_count 仍为 1
    const session = await repos.demoSessions.getActive(
      'demo-test-session',
      new Date().toISOString(),
    );
    expect(session!.analyzeCount).toBe(1);
  });

  it('creates new job when previous job is not active (succeeded)', async () => {
    const repos = await freshRepos();
    const app = await createApp({ repos });
    const cookie = await demoSessionCookie(repos);

    // 第一次创建并标记成功
    const res1 = await app.request('/analyze', {
      method: 'POST',
      headers: demoJsonHeaders(cookie),
      body: JSON.stringify({ username: 'done-user' }),
    });
    const body1 = await res1.json() as any;
    await repos.jobs.claimNext('test-worker');
    await repos.jobs.succeed(body1.jobId, 'prof-001');

    // 第二次创建（同一用户，但之前的任务已成功，应该创建新任务）
    const res2 = await app.request('/analyze', {
      method: 'POST',
      headers: demoJsonHeaders(cookie),
      body: JSON.stringify({ username: 'done-user' }),
    });

    expect(res2.status).toBe(201);
    const body2 = await res2.json() as any;
    expect(body2.jobId).not.toBe(body1.jobId);
    expect(body2.dedup).toBe(false);
  });

  it('returns cached profileId when a fresh complete profile exists', async () => {
    const repos = await freshRepos();
    const app = await createApp({ repos });

    // 预先插入一个 complete 画像
    const profileId = 'prof-cache-001';
    const snapshot = sampleProfile(profileId, 'cached-user');
    await repos.profiles.insert({
      id: profileId,
      analyzerVersion: snapshot.analyzerVersion,
      subjectLogin: 'cached-user',
      subjectClaimed: false,
      dataWindowSince: snapshot.dataWindow.since,
      dataWindowUntil: snapshot.dataWindow.until,
      status: 'complete',
      snapshot,
    });

    // POST /analyze 应直接返回缓存的 profileId，不创建 job
    const res = await app.request('/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'cached-user' }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.profileId).toBe(profileId);
    expect(body.cached).toBe(true);
    expect(body.jobId).toBeUndefined();

    // 没有创建任何 job
    const queued = await repos.jobs.listQueued();
    expect(queued).toHaveLength(0);
  });

  it('creates a new job when cached profile is partial (not complete)', async () => {
    const repos = await freshRepos();
    const app = await createApp({ repos });
    const cookie = await demoSessionCookie(repos);

    // 插入一个 partial 画像（L0 only，未完成）
    const snapshot = sampleProfile('prof-partial-001', 'partial-user');
    await repos.profiles.insert({
      id: 'prof-partial-001',
      analyzerVersion: snapshot.analyzerVersion,
      subjectLogin: 'partial-user',
      subjectClaimed: false,
      dataWindowSince: snapshot.dataWindow.since,
      dataWindowUntil: snapshot.dataWindow.until,
      status: 'partial',
      snapshot,
    });

    const res = await app.request('/analyze', {
      method: 'POST',
      headers: demoJsonHeaders(cookie),
      body: JSON.stringify({ username: 'partial-user' }),
    });

    // partial 画像不命中缓存，应创建新 job
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.jobId).toBeTruthy();
    expect(body.cached).toBeUndefined();
  });

  it('rejects empty username', async () => {
    const app = await createApp({ repos: await freshRepos() });
    const res = await app.request('/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: '' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error).toBe('validation failed');
  });

  it('rejects invalid username format', async () => {
    const app = await createApp({ repos: await freshRepos() });
    const res = await app.request('/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'invalid user!' }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects non-JSON body', async () => {
    const app = await createApp({ repos: await freshRepos() });
    const res = await app.request('/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json',
    });
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error).toBe('invalid JSON body');
  });

  it('creates a gitee-platform job when platform=gitee', async () => {
    const repos = await freshRepos();
    const app = await createApp({ repos });
    const cookie = await demoSessionCookie(repos);

    const res = await app.request('/analyze', {
      method: 'POST',
      headers: demoJsonHeaders(cookie),
      body: JSON.stringify({ username: 'gitee_user', platform: 'gitee' }),
    });

    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.jobId).toMatch(/^job-/);

    const job = await repos.jobs.getById(body.jobId);
    expect(job).toBeDefined();
    expect(job!.subjectPlatform).toBe('gitee');
    expect(job!.subjectLogin).toBe('gitee_user');
  });

  it('creates a fused dual-source job when platform=all', async () => {
    const repos = await freshRepos();
    const app = await createApp({ repos });
    const cookie = await demoSessionCookie(repos);

    const res = await app.request('/analyze', {
      method: 'POST',
      headers: demoJsonHeaders(cookie),
      body: JSON.stringify({ username: 'dual_user', platform: 'all' }),
    });

    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.jobId).toMatch(/^job-/);

    const job = await repos.jobs.getById(body.jobId);
    expect(job).toBeDefined();
    expect(job!.subjectPlatform).toBe('all');
    expect(job!.subjectLogin).toBe('dual_user');
  });

  it('does not serve a single-source github profile as an all (fused) cache hit', async () => {
    const repos = await freshRepos();
    const app = await createApp({ repos });
    const cookie = await demoSessionCookie(repos);

    // 只有一张 github 单源完整画像（insert 默认 subject_platform=github）
    const profileId = 'prof-gh-only';
    const snapshot = sampleProfile(profileId, 'dual-user');
    await repos.profiles.insert({
      id: profileId,
      analyzerVersion: snapshot.analyzerVersion,
      subjectLogin: 'dual-user',
      subjectClaimed: false,
      dataWindowSince: snapshot.dataWindow.since,
      dataWindowUntil: snapshot.dataWindow.until,
      status: 'complete',
      snapshot,
    });

    // platform=all 只认真融合画像，不应命中 github 单源缓存，应新建融合 job
    const res = await app.request('/analyze', {
      method: 'POST',
      headers: demoJsonHeaders(cookie),
      body: JSON.stringify({ username: 'dual-user', platform: 'all' }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.jobId).toBeTruthy();
    expect(body.cached).toBeUndefined();
  });

  it('does not dedup across different platforms for same login', async () => {
    const repos = await freshRepos();
    const app = await createApp({ repos });
    const cookie = await demoSessionCookie(repos, 'demo-multi-platform');

    // GitHub user
    const resGh = await app.request('/analyze', {
      method: 'POST',
      headers: demoJsonHeaders(cookie),
      body: JSON.stringify({ username: 'same-user', platform: 'github' }),
    });
    const bodyGh = await resGh.json() as any;

    // Gitee user with same login — should NOT dedup against GitHub
    const resGitee = await app.request('/analyze', {
      method: 'POST',
      headers: demoJsonHeaders(cookie),
      body: JSON.stringify({ username: 'same-user', platform: 'gitee' }),
    });

    expect(resGitee.status).toBe(201);
    const bodyGitee = await resGitee.json() as any;
    expect(bodyGitee.jobId).not.toBe(bodyGh.jobId);
    expect(bodyGitee.dedup).toBe(false);

    const queued = await repos.jobs.listQueued();
    expect(queued).toHaveLength(2);
  });

  it('rejects invalid platform value', async () => {
    const app = await createApp({ repos: await freshRepos() });
    const res = await app.request('/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'test-user', platform: 'gitlab' }),
    });
    expect(res.status).toBe(400);
  });
});

describe('GET /jobs/:id', () => {
  it('returns job status for existing job', async () => {
    const repos = await freshRepos();
    const app = await createApp({ repos });
    const cookie = await demoSessionCookie(repos);

    // 创建任务
    const createRes = await app.request('/analyze', {
      method: 'POST',
      headers: demoJsonHeaders(cookie),
      body: JSON.stringify({ username: 'status-user' }),
    });
    const { jobId } = await createRes.json() as any;

    // 查询任务
    const res = await app.request(`/jobs/${jobId}`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.id).toBe(jobId);
    expect(body.subject.login).toBe('status-user');
    expect(body.status).toBe('queued');
    expect(body.stage).toBeNull();
    expect(body.attempts).toBe(0);
    expect(body.profileId).toBeNull();
    expect(body.createdAt).toBeTruthy();
  });

  it('returns updated status after job is claimed and succeeds', async () => {
    const repos = await freshRepos();
    const app = await createApp({ repos });
    const cookie = await demoSessionCookie(repos);

    const createRes = await app.request('/analyze', {
      method: 'POST',
      headers: demoJsonHeaders(cookie),
      body: JSON.stringify({ username: 'progress-user' }),
    });
    const { jobId } = await createRes.json() as any;

    // Worker 认领
    await repos.jobs.claimNext('test-worker');
    let res = await app.request(`/jobs/${jobId}`);
    let body = await res.json() as any;
    expect(body.status).toBe('running');
    expect(body.stage).toBe('L0');
    expect(body.attempts).toBe(1);
    expect(body.startedAt).toBeTruthy();

    // 更新阶段
    await repos.jobs.updateStage(jobId, 'L1');
    res = await app.request(`/jobs/${jobId}`);
    body = await res.json() as any;
    expect(body.stage).toBe('L1');

    // 成功
    await repos.jobs.succeed(jobId, 'prof-123');
    res = await app.request(`/jobs/${jobId}`);
    body = await res.json() as any;
    expect(body.status).toBe('succeeded');
    expect(body.stage).toBe('complete');
    expect(body.profileId).toBe('prof-123');
    expect(body.finishedAt).toBeTruthy();
  });

  it('returns 404 for non-existent job', async () => {
    const app = await createApp({ repos: await freshRepos() });
    const res = await app.request('/jobs/job-nonexistent');
    expect(res.status).toBe(404);
    const body = await res.json() as any;
    expect(body.error).toBe('job not found');
  });
});

describe('GET /profiles/:id', () => {
  it('returns profile snapshot for existing profile', async () => {
    const repos = await freshRepos();
    const app = await createApp({ repos });

    // 插入画像
    const profile = sampleProfile('prof-001', 'profile-user');
    await repos.profiles.insert({
      id: 'prof-001',
      analyzerVersion: profile.analyzerVersion,
      subjectLogin: profile.subject.login,
      dataWindowSince: profile.dataWindow.since,
      dataWindowUntil: profile.dataWindow.until,
      status: 'complete',
      snapshot: profile,
    });

    // 查询画像
    const res = await app.request('/profiles/prof-001');
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.id).toBe('prof-001');
    expect(body.analyzerVersion).toBe(profile.analyzerVersion);
    expect(body.subject.login).toBe('profile-user');
    expect(body.status).toBe('complete');
    expect(body.snapshot).toBeTruthy();
    expect(body.snapshot.profileId).toBe('prof-001');
    expect(body.snapshot.authenticity.status).toBe('likely_authentic');
  });

  it('returns 404 for non-existent profile', async () => {
    const app = await createApp({ repos: await freshRepos() });
    const res = await app.request('/profiles/prof-nonexistent');
    expect(res.status).toBe(404);
    const body = await res.json() as any;
    expect(body.error).toBe('profile not found');
  });
});

describe('GET /profiles/:id/exportable', () => {
  it('returns the exportable projection for P1 extension consumption', async () => {
    const repos = await freshRepos();
    const app = await createApp({ repos });
    const profile = sampleProfile('prof-001', 'profile-user');
    await repos.profiles.insert({
      id: 'prof-001',
      analyzerVersion: profile.analyzerVersion,
      subjectLogin: profile.subject.login,
      dataWindowSince: profile.dataWindow.since,
      dataWindowUntil: profile.dataWindow.until,
      status: 'complete',
      snapshot: profile,
    });

    const res = await app.request('/profiles/prof-001/exportable');
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.schemaVersion).toBe('0.1');
    expect(body.profileId).toBe('prof-001');
    expect(body.subject.login).toBe('profile-user');
    expect(body.subject.profileUrl).toBe('https://github.com/profile-user');
    expect(body.headline).toBe('Test developer');
    expect(body.skills).toEqual([]);
    expect(body.authenticity.status).toBe('likely_authentic');
    expect(body.authenticity.confidence).toBe(0.75);
  });

  it('returns 404 for non-existent profile', async () => {
    const app = await createApp({ repos: await freshRepos() });
    const res = await app.request('/profiles/prof-nonexistent/exportable');
    expect(res.status).toBe(404);
    const body = await res.json() as any;
    expect(body.error).toBe('profile not found');
  });
});

describe('GET /profiles/by-subject/:platform/:login', () => {
  async function seedProfile(
    repos: StorageContext,
    id: string,
    login: string,
    platform: 'github' | 'gitee',
    status: 'complete' | 'partial' = 'complete',
  ): Promise<void> {
    const snapshot = sampleProfile(id, login);
    await repos.profiles.insert({
      id,
      analyzerVersion: snapshot.analyzerVersion,
      subjectPlatform: platform,
      subjectLogin: login,
      subjectClaimed: false,
      dataWindowSince: snapshot.dataWindow.since,
      dataWindowUntil: snapshot.dataWindow.until,
      status,
      snapshot: status === 'complete' ? snapshot : { ...snapshot, subject: { ...snapshot.subject, platform } },
    });
  }

  it('returns the profileId pointer for an existing complete github profile (anonymous, no TTL)', async () => {
    const repos = await freshRepos();
    const app = await createApp({ repos });
    await seedProfile(repos, 'prof-gh-1', 'torvalds', 'github');

    // 无任何 Cookie（匿名）也应命中；端点刻意不读 24h 缓存 TTL、不扣配额、不触发分析
    const res = await app.request('/profiles/by-subject/github/torvalds');
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.profileId).toBe('prof-gh-1');
    expect(body.status).toBe('complete');
    expect(body.cached).toBe(true);
    expect(body.analyzerVersion).toBeTruthy();
    expect(body.updatedAt).toBeTruthy();
    // 只回 profileId 指针，不在登录名维度重复暴露画像内容（内容仍走公开 exportable 投影）
    expect(body.snapshot).toBeUndefined();
    expect(body.skills).toBeUndefined();

    // 只读解析不应创建任何分析任务
    const queued = await repos.jobs.listQueued();
    expect(queued).toHaveLength(0);
  });

  it('resolves a gitee-platform complete profile', async () => {
    const repos = await freshRepos();
    const app = await createApp({ repos });
    await seedProfile(repos, 'prof-gitee-1', 'gitee_dev', 'gitee');

    const res = await app.request('/profiles/by-subject/gitee/gitee_dev');
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.profileId).toBe('prof-gitee-1');
  });

  it('does not match a same-login profile on another platform', async () => {
    const repos = await freshRepos();
    const app = await createApp({ repos });
    await seedProfile(repos, 'prof-gh-only', 'same-login', 'github');

    const res = await app.request('/profiles/by-subject/gitee/same-login');
    expect(res.status).toBe(404);
    const body = await res.json() as any;
    expect(body.code).toBe('PROFILE_NOT_FOUND');
  });

  it('returns 404 when no profile exists for the subject', async () => {
    const app = await createApp({ repos: await freshRepos() });
    const res = await app.request('/profiles/by-subject/github/nobody');
    expect(res.status).toBe(404);
    const body = await res.json() as any;
    expect(body.code).toBe('PROFILE_NOT_FOUND');
  });

  it('returns 404 when the latest profile is only partial (not complete)', async () => {
    const repos = await freshRepos();
    const app = await createApp({ repos });
    await seedProfile(repos, 'prof-partial', 'partial-user', 'github', 'partial');

    const res = await app.request('/profiles/by-subject/github/partial-user');
    expect(res.status).toBe(404);
    const body = await res.json() as any;
    expect(body.code).toBe('PROFILE_NOT_FOUND');
  });

  it('rejects platform=all (no single-subject snapshot for fused jobs)', async () => {
    const app = await createApp({ repos: await freshRepos() });
    const res = await app.request('/profiles/by-subject/all/someone');
    expect(res.status).toBe(400);
  });

  it('rejects a login that does not start with an alphanumeric', async () => {
    const app = await createApp({ repos: await freshRepos() });
    const res = await app.request('/profiles/by-subject/github/-bad');
    expect(res.status).toBe(400);
  });
});

describe('404 fallback', () => {
  it('returns 404 for unknown routes', async () => {
    const app = await createApp({ repos: await freshRepos() });
    const res = await app.request('/unknown-route');
    expect(res.status).toBe(404);
    const body = await res.json() as any;
    expect(body.error).toBe('not found');
  });
});
