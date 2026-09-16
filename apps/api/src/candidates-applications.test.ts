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
