/**
 * 岗位定向简历 API 集成测试（P-R2）：
 * - POST /resumes/build  json（默认）/ html / md 三种 format
 * - 本地补填 local 进入草稿、画像外字段不臆造
 * - 证据行 → evidenceHighlights 挂 evidenceRefs
 * - 404（画像/岗位）、400（请求体校验）、零命中 low_match 降级
 * 全部用内存 SQLite + 仓储注入，不启动服务器、不打网络、不调 LLM。
 */
import { describe, expect, it } from 'vitest';
import type { AbilityProfile, JobPosting, ResumeDraft, SkillTag } from '@jobagent/shared';
import { createStorage, type NewJobPosting, type StorageContext } from '@jobagent/storage';
import { createApp } from './index.js';

const NOW = '2026-09-15T00:00:00.000Z';
let seq = 0;

/** POST /resumes/build 成功响应（format 缺省为结构化 draft）。 */
interface BuildOkResponse {
  format?: 'html' | 'md';
  draft: ResumeDraft;
  html?: string;
  markdown?: string;
}

function posting(overrides: Partial<JobPosting> & { title: string }): NewJobPosting {
  seq += 1;
  const base: JobPosting = {
    jobId: `ext-${seq}`,
    source: 'greenhouse',
    sourceUrl: `https://example.test/jobs/${seq}`,
    title: '',
    company: 'Acme',
    remote: false,
    postedAt: '2026-09-01T00:00:00.000Z',
    fetchedAt: NOW,
    tags: [],
  };
  return { ...base, ...overrides, normalizedKey: `nk-${seq}` };
}

function profileWith(tags: SkillTag[]): AbilityProfile {
  return {
    profileId: 'p-resume',
    analyzerVersion: 'schema-0.1-engine-0.2',
    generatedAt: NOW,
    dataWindow: { since: '2024-01-01T00:00:00.000Z', until: '2026-09-01T00:00:00.000Z' },
    analysisLayers: ['L0', 'L1'],
    subject: { platform: 'github', login: 'alice', displayName: 'Alice A', profileUrl: 'https://github.com/alice', claimed: false },
    summary: { headline: 'Backend developer focused on reliable systems' },
    skillTags: tags,
    activity: { longevityMonths: 24, metrics: { commitCount: 120 } },
    collaboration: { evidenceRefs: [] },
    authenticity: { status: 'likely_authentic', confidence: 0.82, signals: [] },
    interviewQuestions: [],
    caveats: [],
  };
}

async function harness(): Promise<{ app: Awaited<ReturnType<typeof createApp>>; repos: StorageContext; jobId: string }> {
  const repos = await createStorage({ sqlitePath: ':memory:' });

  const tags: SkillTag[] = [
    { name: 'typescript', kind: 'language', depth: 'proficient', confidence: 0.9, evidenceRefs: ['ev-ts1'] },
    { name: 'react', kind: 'framework', depth: 'used', confidence: 0.5, evidenceRefs: [] },
  ];
  await repos.profiles.insert({
    id: 'p-resume',
    analyzerVersion: 'schema-0.1-engine-0.2',
    subjectLogin: 'alice',
    dataWindowSince: '2024-01-01T00:00:00.000Z',
    dataWindowUntil: '2026-09-01T00:00:00.000Z',
    status: 'complete',
    snapshot: profileWith(tags),
  });
  await repos.evidence.insert({
    id: 'ev-ts1',
    profileId: 'p-resume',
    sourceType: 'pull_request',
    url: 'https://github.com/acme/core/pull/12',
    layer: 'L1',
    claim: 'Merged a TypeScript concurrency fix',
    rawRef: 'acme/core#12',
  });

  await repos.jobPostings.upsertBatch(
    [
      posting({ title: 'Senior TypeScript Engineer', tags: ['typescript', 'node.js'], description: 'typescript backend role' }),
      posting({ title: 'Sales Development Representative', tags: ['sales'], description: 'outbound pipeline' }),
    ],
    NOW,
  );
  const rows = await repos.jobPostings.search({});
  const tsJob = rows.find((r) => r.title === 'Senior TypeScript Engineer')!;
  const app = await createApp({ repos, now: () => NOW });
  return { app, repos, jobId: tsJob.id };
}

describe('POST /resumes/build', () => {
  it('returns a structured draft (json default) with matched job and provenance', async () => {
    const { app, jobId } = await harness();
    const res = await app.request('/resumes/build', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profileId: 'p-resume', jobId }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as BuildOkResponse;
    expect(body.format).toBeUndefined();
    expect(body.draft.targetJob.title).toBe('Senior TypeScript Engineer');
    expect(body.draft.targetJob.matchScore).toBeGreaterThan(0);
    expect(body.draft.targetJob.matchedSkills).toContain('typescript');
    expect(body.draft.subject.login).toBe('alice');
    expect(body.draft.provenance.profileId).toBe('p-resume');
    expect(body.draft.generatedAt).toBe(NOW);
  });

  it('renders html and markdown on demand', async () => {
    const { app, jobId } = await harness();
    const htmlRes = await app.request('/resumes/build', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profileId: 'p-resume', jobId, format: 'html', locale: 'en' }),
    });
    expect(htmlRes.status).toBe(200);
    const htmlBody = (await htmlRes.json()) as BuildOkResponse;
    expect(htmlBody.format).toBe('html');
    expect(typeof htmlBody.html).toBe('string');
    expect(htmlBody.html).toContain('Senior TypeScript Engineer');
    // 打印 CSS 必须存在（浏览器打印→PDF，设计 §5.1）
    expect(htmlBody.html).toContain('@media print');
    expect(htmlBody.draft.targetJob.title).toBe('Senior TypeScript Engineer');

    const mdRes = await app.request('/resumes/build', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profileId: 'p-resume', jobId, format: 'md' }),
    });
    const mdBody = (await mdRes.json()) as BuildOkResponse;
    expect(mdBody.format).toBe('md');
    expect(mdBody.markdown).toContain('Senior TypeScript Engineer');
  });

  it('folds local-only fields into the draft as local-sourced entries (no fabrication)', async () => {
    const { app, jobId } = await harness();
    const res = await app.request('/resumes/build', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        profileId: 'p-resume',
        jobId,
        local: {
          fullName: 'Alice Zhang',
          email: 'alice@example.com',
          education: [{ school: 'Example University', degree: 'BSc CS', period: '2016–2020' }],
        },
      }),
    });
    expect(res.status).toBe(200);
    const { draft } = (await res.json()) as BuildOkResponse;
    expect(draft.header.name).toBe('Alice Zhang');
    expect(draft.header.contact?.email).toBe('alice@example.com');
    const edu = draft.localSections.education;
    expect(edu).toHaveLength(1);
    expect(edu[0]?.source).toBe('local');
    expect(edu[0]?.evidenceRefs).toEqual([]);
    expect(edu[0]?.text).toContain('Example University');
  });

  it('attaches evidenceRefs to profile-sourced highlights', async () => {
    const { app, jobId } = await harness();
    const res = await app.request('/resumes/build', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profileId: 'p-resume', jobId }),
    });
    const { draft } = (await res.json()) as BuildOkResponse;
    const profileEntries = draft.evidenceHighlights.filter((e) => e.source === 'profile');
    expect(profileEntries.length).toBeGreaterThan(0);
    for (const entry of profileEntries) {
      expect(entry.evidenceRefs.length).toBeGreaterThan(0);
    }
    const refs = profileEntries.flatMap((e) => e.evidenceRefs);
    expect(refs).toContain('ev-ts1');
  });

  it('degrades to low tier without throwing on a zero-match job', async () => {
    const { app, repos } = await harness();
    const rows = await repos.jobPostings.search({});
    const salesJob = rows.find((r) => r.title === 'Sales Development Representative')!;
    const res = await app.request('/resumes/build', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profileId: 'p-resume', jobId: salesJob.id }),
    });
    expect(res.status).toBe(200);
    const { draft } = (await res.json()) as BuildOkResponse;
    expect(draft.targetJob.tier).toBe('low');
    expect(draft.targetJob.matchScore).toBe(0);
  });

  it('404s on missing profile or job posting', async () => {
    const { app, jobId } = await harness();
    const noProfile = await app.request('/resumes/build', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profileId: 'nope', jobId }),
    });
    expect(noProfile.status).toBe(404);

    const noJob = await app.request('/resumes/build', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profileId: 'p-resume', jobId: 'nope' }),
    });
    expect(noJob.status).toBe(404);
  });

  it('400s on invalid body (missing jobId, bad locale)', async () => {
    const { app } = await harness();
    const missing = await app.request('/resumes/build', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profileId: 'p-resume' }),
    });
    expect(missing.status).toBe(400);

    const badLocale = await app.request('/resumes/build', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profileId: 'p-resume', jobId: 'x', locale: 'fr' }),
    });
    expect(badLocale.status).toBe(400);

    const notJson = await app.request('/resumes/build', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json',
    });
    expect(notJson.status).toBe(400);
  });
});
