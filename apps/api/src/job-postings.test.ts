/**
 * 职位聚合 API 集成测试（P2-D）：
 * - GET  /job-postings        检索 + query 校验
 * - GET  /job-postings/stats  按源统计（验证不被 :id 路由吞掉）
 * - GET  /job-postings/:id    单条 / 404
 * - POST /job-postings/match  画像技能匹配打分
 * 全部用内存 SQLite + 仓储注入，不启动服务器、不打网络。
 */
import { describe, expect, it } from 'vitest';
import type { AbilityProfile, JobPosting, JobSource } from '@jobagent/shared';
import { createStorage, type NewJobPosting, type StorageContext } from '@jobagent/storage';
import { createApp } from './index.js';

// 动态当前时间：upsert 以它为 last_seen_at，T24① stats 只数 7 天窗口内的行，静态日期会随测试腐烂
const NOW = new Date().toISOString();
let seq = 0;

function job(overrides: Partial<JobPosting> & { title: string }): NewJobPosting {
  seq += 1;
  const base: JobPosting = {
    jobId: `ext-${seq}`,
    source: 'remoteok',
    sourceUrl: `https://example.test/${seq}`,
    title: '',
    company: 'Acme',
    remote: false,
    postedAt: '2026-09-01T00:00:00.000Z',
    fetchedAt: NOW,
    tags: [],
  };
  return { ...base, ...overrides, normalizedKey: `nk-${seq}` };
}

async function harness(
  rows: NewJobPosting[],
): Promise<{ app: Awaited<ReturnType<typeof createApp>>; repos: StorageContext }> {
  const repos = await createStorage({ sqlitePath: ':memory:' });
  if (rows.length > 0) await repos.jobPostings.upsertBatch(rows, NOW);
  const app = await createApp({ repos });
  return { app, repos };
}

/** 造一个带指定技能的最小 AbilityProfile（用于匹配接线测试）。 */
function profileWithSkills(profileId: string, skills: string[]): AbilityProfile {
  return {
    profileId,
    analyzerVersion: 'schema-0.1-engine-0.1.0',
    generatedAt: '2026-09-14T00:00:00.000Z',
    dataWindow: { since: '2025-09-14T00:00:00.000Z', until: '2026-09-14T00:00:00.000Z' },
    analysisLayers: ['L0', 'L1'],
    subject: { platform: 'github', login: 'match-user', profileUrl: 'https://github.com/match-user', claimed: false },
    summary: { headline: 'Match test developer' },
    skillTags: skills.map((name) => ({ name, kind: 'language' as const, depth: 'proficient' as const, confidence: 0.8, evidenceRefs: [] })),
    activity: { longevityMonths: 12 },
    collaboration: { evidenceRefs: [] },
    authenticity: { status: 'likely_authentic', confidence: 0.8, signals: [] },
    interviewQuestions: [],
    caveats: [],
  };
}

async function insertProfile(repos: StorageContext, profileId: string, skills: string[]): Promise<void> {
  const p = profileWithSkills(profileId, skills);
  await repos.profiles.insert({
    id: profileId,
    analyzerVersion: p.analyzerVersion,
    subjectLogin: p.subject.login,
    dataWindowSince: p.dataWindow.since,
    dataWindowUntil: p.dataWindow.until,
    status: 'complete',
    snapshot: p,
  });
}

/** 造带完整 SkillTag（含 evidenceRefs）的画像，并写入对应证据行（决策 #10 可解释性测试用）。 */
async function insertProfileWithEvidence(
  repos: StorageContext,
  profileId: string,
  tags: AbilityProfile['skillTags'],
  evidence: Array<{ id: string; sourceType: string; url: string; claim: string; rawRef: string; layer?: string }>,
): Promise<void> {
  const p = profileWithSkills(
    profileId,
    tags.map((t) => t.name),
  );
  p.skillTags = tags;
  await repos.profiles.insert({
    id: profileId,
    analyzerVersion: p.analyzerVersion,
    subjectLogin: p.subject.login,
    dataWindowSince: p.dataWindow.since,
    dataWindowUntil: p.dataWindow.until,
    status: 'complete',
    snapshot: p,
  });
  for (const e of evidence) {
    await repos.evidence.insert({
      id: e.id,
      profileId,
      sourceType: e.sourceType,
      url: e.url,
      layer: e.layer ?? 'L1',
      claim: e.claim,
      rawRef: e.rawRef,
    });
  }
}

describe('GET /job-postings', () => {
  it('returns active postings', async () => {
    const { app } = await harness([job({ title: 'Python Engineer' }), job({ title: 'Sales Lead' })]);
    const res = await app.request('/job-postings');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: JobPosting[] };
    expect(body.items).toHaveLength(2);
  });

  it('filters by remote and source', async () => {
    const { app } = await harness([
      job({ title: 'Remote Python', remote: true, source: 'remoteok' }),
      job({ title: 'Onsite Python', remote: false, source: 'lever' }),
    ]);
    const res = await app.request('/job-postings?remote=true&sources=remoteok');
    const body = (await res.json()) as { items: JobPosting[] };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]!.title).toBe('Remote Python');
  });

  it('rejects an unknown source with 400', async () => {
    const { app } = await harness([]);
    const res = await app.request('/job-postings?sources=linkedin');
    expect(res.status).toBe(400);
  });

  it('rejects a non-numeric limit with 400', async () => {
    const { app } = await harness([]);
    const res = await app.request('/job-postings?limit=abc');
    expect(res.status).toBe(400);
  });
});

describe('GET /job-postings/stats and /:id', () => {
  it('stats is not swallowed by the :id route', async () => {
    const { app } = await harness([
      job({ title: 'A', source: 'remoteok' }),
      job({ title: 'B', source: 'lever' }),
      job({ title: 'C', source: 'lever' }),
    ]);
    const res = await app.request('/job-postings/stats');
    expect(res.status).toBe(200);
    // T24①：stats 只统计新鲜窗口内的 active 行（harness 插入的行 last_seen_at=now，全部新鲜）
    const body = (await res.json()) as { active: number; inactive: number; staleAfterDays: number };
    expect(body.active).toBe(3);
    expect(body.inactive).toBe(0);
    expect(body.staleAfterDays).toBe(7);
  });

  it('fetches one posting by id and 404s otherwise', async () => {
    const { app, repos } = await harness([job({ title: 'Findable' })]);
    const found = await repos.jobPostings.search({});
    const id = found[0]!.id;
    const ok = await app.request(`/job-postings/${id}`);
    expect(ok.status).toBe(200);
    expect((await ok.json() as JobPosting).title).toBe('Findable');
    const missing = await app.request('/job-postings/nope-id');
    expect(missing.status).toBe(404);
  });
});

describe('POST /job-postings/match', () => {
  it('ranks title hits above description hits and reports matched skills', async () => {
    const { app } = await harness([
      job({ title: 'Backend Engineer', description: 'we write python services' }),
      job({ title: 'Senior Python Engineer', tags: ['python'], description: 'python' }),
    ]);
    const res = await app.request('/job-postings/match', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ skills: ['Python'] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      total: number;
      matches: Array<{ score: number; matchedSkills: string[]; posting: JobPosting }>;
    };
    expect(body.total).toBe(2);
    expect(body.matches[0]!.posting.title).toBe('Senior Python Engineer');
    expect(body.matches[0]!.matchedSkills).toEqual(['Python']);
    expect(body.matches[0]!.score).toBeGreaterThan(body.matches[1]!.score);
  });

  it('applies the remote hard filter', async () => {
    const { app } = await harness([
      job({ title: 'Python Engineer', remote: true }),
      job({ title: 'Python Engineer', remote: false }),
    ]);
    const res = await app.request('/job-postings/match', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ skills: ['python'], remote: true }),
    });
    const body = (await res.json()) as { total: number };
    expect(body.total).toBe(1);
  });

  it('requires at least one skill', async () => {
    const { app } = await harness([job({ title: 'Python Engineer' })]);
    const res = await app.request('/job-postings/match', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ skills: [] }),
    });
    expect(res.status).toBe(400);
  });

  it('returns field breakdown and skill hits but no profile reasons for explicit skills', async () => {
    const { app } = await harness([job({ title: 'Python Engineer', tags: ['python'] })]);
    const res = await app.request('/job-postings/match', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ skills: ['Python'] }),
    });
    const body = (await res.json()) as {
      evidence?: unknown;
      matches: Array<Record<string, unknown>>;
    };
    const m = body.matches[0]!;
    // No profile -> no skill metadata / evidence dictionary
    expect(m.skillReasons).toBeUndefined();
    expect(body.evidence).toBeUndefined();
    // But the mechanical field-level breakdown is always present
    expect(m.fieldScores).toEqual({ title: 3, tags: 2, description: 0 });
    expect(m.skillHits).toEqual([{ skill: 'Python', score: 5, fields: ['title', 'tags'] }]);
  });
});

describe('POST /job-postings/match with profileId', () => {
  it('resolves skills from profile snapshot and ranks matches', async () => {
    const { app, repos } = await harness([
      job({ title: 'Backend Engineer', description: 'we write python services' }),
      job({ title: 'Senior Python Engineer', tags: ['python'], description: 'python' }),
    ]);
    await insertProfile(repos, 'prof-match', ['Python']);
    const res = await app.request('/job-postings/match', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profileId: 'prof-match' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      total: number;
      profileSkills: string[];
      matches: Array<{ score: number; matchedSkills: string[]; posting: JobPosting }>;
    };
    expect(body.profileSkills).toEqual(['Python']);
    expect(body.total).toBe(2);
    expect(body.matches[0]!.posting.title).toBe('Senior Python Engineer');
    expect(body.matches[0]!.matchedSkills).toEqual(['Python']);
  });

  it('returns 404 when profileId does not exist', async () => {
    const { app } = await harness([job({ title: 'Python Engineer' })]);
    const res = await app.request('/job-postings/match', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profileId: 'prof-nope' }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('profile not found');
  });

  it('profileId takes precedence over explicit skills', async () => {
    const { app, repos } = await harness([
      job({ title: 'Python Engineer' }),
      job({ title: 'Rust Engineer' }),
    ]);
    await insertProfile(repos, 'prof-rust', ['Rust']);
    const res = await app.request('/job-postings/match', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profileId: 'prof-rust', skills: ['Python'] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { total: number; profileSkills: string[]; matches: Array<{ posting: JobPosting }> };
    expect(body.profileSkills).toEqual(['Rust']);
    expect(body.total).toBe(1);
    expect(body.matches[0]!.posting.title).toBe('Rust Engineer');
  });

  it('returns 400 when neither skills nor profileId is provided', async () => {
    const { app } = await harness([job({ title: 'Python Engineer' })]);
    const res = await app.request('/job-postings/match', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('attaches skill reasons and traceable evidence when matching by profileId', async () => {
    const { app, repos } = await harness([job({ title: 'Python Engineer', tags: ['python'] })]);
    await insertProfileWithEvidence(
      repos,
      'prof-py',
      [{ name: 'Python', kind: 'language', depth: 'proficient', confidence: 0.8, evidenceRefs: ['py-1'] }],
      [{ id: 'py-1', sourceType: 'pr', url: 'https://github.com/u/x/pull/2', claim: 'authored python PR', rawRef: '#2' }],
    );
    const res = await app.request('/job-postings/match', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profileId: 'prof-py' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      profileSkills: string[];
      evidence: Record<string, { sourceType: string; url: string; claim: string }>;
      matches: Array<{ skillReasons: Array<Record<string, unknown>> }>;
    };
    expect(body.profileSkills).toEqual(['Python']);
    expect(body.matches[0]!.skillReasons[0]).toMatchObject({
      skill: 'Python',
      kind: 'language',
      depth: 'proficient',
      evidenceRefs: ['py-1'],
    });
    expect(body.evidence['py-1']).toEqual({
      sourceType: 'pr',
      url: 'https://github.com/u/x/pull/2',
      claim: 'authored python PR',
    });
  });
});

describe('GET /profiles/:id/job-recommendations', () => {
  it('returns ranked job recommendations from profile skills', async () => {
    const { app, repos } = await harness([
      job({ title: 'Backend Engineer', description: 'we write python services' }),
      job({ title: 'Senior Python Engineer', tags: ['python'], description: 'python' }),
      job({ title: 'Sales Lead' }),
    ]);
    await insertProfile(repos, 'prof-rec', ['Python']);
    const res = await app.request('/profiles/prof-rec/job-recommendations');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      profileId: string;
      profileSkills: string[];
      total: number;
      candidatePool: number;
      matches: Array<{ score: number; matchedSkills: string[]; posting: JobPosting }>;
    };
    expect(body.profileId).toBe('prof-rec');
    expect(body.profileSkills).toEqual(['Python']);
    expect(body.total).toBe(2);
    expect(body.candidatePool).toBe(3);
    expect(body.matches[0]!.posting.title).toBe('Senior Python Engineer');
    expect(body.matches[0]!.matchedSkills).toEqual(['Python']);
    expect(body.matches[0]!.score).toBeGreaterThan(body.matches[1]!.score);
  });

  it('returns 404 for non-existent profile', async () => {
    const { app } = await harness([job({ title: 'Python Engineer' })]);
    const res = await app.request('/profiles/prof-nope/job-recommendations');
    expect(res.status).toBe(404);
  });

  it('returns empty matches when profile has no skill tags', async () => {
    const { app, repos } = await harness([job({ title: 'Python Engineer' })]);
    await insertProfile(repos, 'prof-empty', []);
    const res = await app.request('/profiles/prof-empty/job-recommendations');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { total: number; matches: unknown[] };
    expect(body.total).toBe(0);
    expect(body.matches).toEqual([]);
  });

  it('rejects invalid source query param', async () => {
    const { app, repos } = await harness([job({ title: 'Python Engineer' })]);
    await insertProfile(repos, 'prof-src', ['Python']);
    const res = await app.request('/profiles/prof-src/job-recommendations?sources=linkedin');
    expect(res.status).toBe(400);
  });

  it('applies remote hard filter via query', async () => {
    const { app, repos } = await harness([
      job({ title: 'Python Engineer', remote: true }),
      job({ title: 'Python Engineer', remote: false }),
    ]);
    await insertProfile(repos, 'prof-remote', ['Python']);
    const res = await app.request('/profiles/prof-remote/job-recommendations?remote=true');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { total: number };
    expect(body.total).toBe(1);
  });

  it('explains matches via field scores, per-skill reasons and only referenced evidence', async () => {
    const { app, repos } = await harness([
      job({ title: 'Senior TypeScript Engineer', tags: ['typescript', 'react'], description: 'typescript and react' }),
    ]);
    await insertProfileWithEvidence(
      repos,
      'prof-explain',
      [
        { name: 'TypeScript', kind: 'language', depth: 'proficient', confidence: 0.9, evidenceRefs: ['ev-1', 'ev-2'] },
        { name: 'React', kind: 'framework', depth: 'used', confidence: 0.6, evidenceRefs: ['ev-3'] },
      ],
      [
        { id: 'ev-1', sourceType: 'pr', url: 'https://github.com/u/r/pull/1', claim: 'authored TS PR', rawRef: '#1' },
        { id: 'ev-2', sourceType: 'commit', url: 'https://github.com/u/r/commit/c1', claim: 'TS commit', rawRef: 'c1' },
        { id: 'ev-3', sourceType: 'repo', url: 'https://github.com/u/r', claim: 'react repo', rawRef: 'u/r', layer: 'L0' },
        // Unreferenced evidence must not leak into the response dictionary
        { id: 'ev-x', sourceType: 'issue', url: 'https://github.com/u/r/issues/9', claim: 'unrelated', rawRef: '#9' },
      ],
    );
    const res = await app.request('/profiles/prof-explain/job-recommendations');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      evidence: Record<string, { sourceType: string; url: string; claim: string }>;
      matches: Array<{
        score: number;
        fieldScores: { title: number; tags: number; description: number };
        skillHits: Array<{ skill: string; score: number; fields: string[] }>;
        skillReasons: Array<Record<string, unknown>>;
      }>;
    };
    const m = body.matches[0]!;
    // TS hits title+tags+description; React hits tags+description
    expect(m.fieldScores).toEqual({ title: 3, tags: 4, description: 2 });
    expect(m.score).toBe(9);
    expect(m.skillHits.map((h) => h.skill)).toEqual(['TypeScript', 'React']);
    expect(m.skillReasons[0]).toMatchObject({ skill: 'TypeScript', kind: 'language', depth: 'proficient' });
    expect(m.skillReasons[1]).toMatchObject({ skill: 'React', kind: 'framework', depth: 'used' });
    // Dictionary contains only evidence referenced by matched skills (ev-x excluded)
    expect(Object.keys(body.evidence).sort()).toEqual(['ev-1', 'ev-2', 'ev-3']);
    expect(body.evidence['ev-1']!.claim).toBe('authored TS PR');
  });
});
