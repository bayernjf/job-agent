/**
 * 职位聚合 API 集成测试（P2-D）：
 * - GET  /job-postings        检索 + query 校验
 * - GET  /job-postings/stats  按源统计（验证不被 :id 路由吞掉）
 * - GET  /job-postings/:id    单条 / 404
 * - POST /job-postings/match  画像技能匹配打分
 * 全部用内存 SQLite + 仓储注入，不启动服务器、不打网络。
 */
import { describe, expect, it } from 'vitest';
import type { JobPosting, JobSource } from '@jobagent/shared';
import { createStorage, type NewJobPosting, type StorageContext } from '@jobagent/storage';
import { createApp } from './index.js';
import type { Hono } from 'hono';

const NOW = '2026-09-13T00:00:00.000Z';
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

async function harness(rows: NewJobPosting[]): Promise<{ app: Hono; repos: StorageContext }> {
  const repos = await createStorage({ sqlitePath: ':memory:' });
  if (rows.length > 0) await repos.jobPostings.upsertBatch(rows, NOW);
  const app = await createApp({ repos });
  return { app, repos };
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
    const body = (await res.json()) as { active: Record<string, number> };
    expect(body.active.remoteok).toBe(1);
    expect(body.active.lever).toBe(2);
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
});
