/**
 * 搜岗执行链测试：claimNextQueued → 搜索 → URL 去重 → 抽取 → 入库 → finish 回写。
 * 仓储与搜索客户端全为内存 fake，验证状态机与计数，不打网络。
 */
import { describe, expect, it } from 'vitest';
import type { SearchConditions } from './types.js';
import { executeSearchRun, runSearchTick } from './run.js';
import type { RunSearchDeps } from './run.js';
import type { SearchClient, SearchResultItem } from './types.js';

interface RunRow {
  runId: string;
  accountId: string;
  query: string;
  conditions: SearchConditions;
  status: string;
  executedQueries: string[];
  resultsCount: number;
  newCount: number;
  error: string | null;
}

function makeRepos(initial: RunRow[]): any {
  const runs: RunRow[] = [...initial];
  const postings: unknown[] = [];
  return {
    searchRuns: {
      claimNextQueued: async () => {
        const idx = runs.findIndex((r) => r.status === 'queued');
        if (idx === -1) return null;
        runs[idx]!.status = 'running';
        return { ...runs[idx]! };
      },
      finish: async (
        runId: string,
        patch: { status: string; queries: string[]; resultsCount: number; newCount: number; error: string | null },
      ) => {
        const idx = runs.findIndex((r) => r.runId === runId);
        if (idx === -1) return null;
        runs[idx] = { ...runs[idx]!, ...patch };
        return { ...runs[idx]! };
      },
      _rows: runs,
    },
    jobPostings: {
      upsertBatch: async (rows: unknown[]) => {
        let inserted = 0;
        for (const r of rows as Array<{ searchRunId?: string | null }>) {
          if (!postings.some((p) => (p as { searchRunId?: string | null }).searchRunId === r.searchRunId)) {
            inserted += 1;
          }
          postings.push(r);
        }
        return { inserted, updated: 0, unchanged: 0 };
      },
      _rows: postings,
    },
  };
}

const COND: SearchConditions = {
  queries: ['Berlin backend engineer'],
  location: 'Berlin',
  remote: false,
  salaryMinUsd: null,
  keywords: [],
};

function searchClient(items: SearchResultItem[]): SearchClient {
  return { provider: 'tavily', search: async () => items };
}

describe('executeSearchRun', () => {
  it('dedupes URLs, extracts JDs, ingests with searchRunId, finishes done', async () => {
    const repos = makeRepos([
      { runId: 'r1', accountId: 'a1', query: 'Berlin backend engineer', conditions: COND, status: 'queued', executedQueries: [], resultsCount: 0, newCount: 0, error: null },
    ]);
    const deps: RunSearchDeps = {
      searchRuns: repos.searchRuns,
      jobPostings: repos.jobPostings,
      searchClient: searchClient([
        { title: 'Backend Engineer at Acme', url: 'https://acme.com/jobs/1', content: 'Hiring in Berlin. $100k', score: 0.9 },
        { title: 'Backend Engineer at Acme', url: 'https://acme.com/jobs/1', content: 'duplicate URL', score: 0.9 },
        { title: 'no company here', url: 'https://junk.example/x', content: 'spam spam spam', score: 0.1 },
      ]),
    };
    const claimed = (await repos.searchRuns.claimNextQueued()) as RunRow;
    const finished = await executeSearchRun(deps, claimed as unknown as Parameters<typeof executeSearchRun>[1]);

    expect(finished.status).toBe('done');
    expect(finished.resultsCount).toBe(2);
    expect(finished.newCount).toBe(1);
    expect((repos.jobPostings._rows[0] as { searchRunId?: string | null }).searchRunId).toBe('r1');
  });

  it('runs an extra ATS-domain recall with include_domains on the first query', async () => {
    const repos = makeRepos([
      { runId: 'r3', accountId: 'a1', query: 'Berlin backend engineer', conditions: COND, status: 'queued', executedQueries: [], resultsCount: 0, newCount: 0, error: null },
    ]);
    const calls: Array<{ query: string; includeDomains?: string[] }> = [];
    const deps: RunSearchDeps = {
      searchRuns: repos.searchRuns,
      jobPostings: repos.jobPostings,
      searchClient: {
        provider: 'tavily',
        search: async (q, opts) => {
          calls.push({ query: q, includeDomains: opts?.includeDomains });
          return [
            {
              title: 'Backend Engineer at Acme',
              url: 'https://jobs.lever.co/acme/abc-guid',
              content: 'Responsibilities: build APIs. Requirements: experience with Go and PostgreSQL.',
              score: 0.9,
            },
          ];
        },
      },
    };
    const run = (await repos.searchRuns.claimNextQueued()) as RunRow;
    await executeSearchRun(deps, run as unknown as Parameters<typeof executeSearchRun>[1]);

    expect(calls).toHaveLength(2); // 通用 + ATS
    expect(calls[0]!.includeDomains).toBeUndefined();
    expect(calls[1]!.query).toBe('Berlin backend engineer');
    expect(calls[1]!.includeDomains).toBeDefined();
    expect(calls[1]!.includeDomains).toContain('jobs.lever.co');
    expect(calls[1]!.includeDomains).toContain('boards.greenhouse.io');
  });

  it('marks failed when every query errors and nothing was ingested', async () => {
    const repos = makeRepos([
      { runId: 'r2', accountId: 'a1', query: 'x', conditions: COND, status: 'queued', executedQueries: [], resultsCount: 0, newCount: 0, error: null },
    ]);
    const deps: RunSearchDeps = {
      searchRuns: repos.searchRuns,
      jobPostings: repos.jobPostings,
      searchClient: {
        provider: 'tavily',
        search: async () => {
          throw new Error('search api down');
        },
      },
    };
    const run = (await repos.searchRuns.claimNextQueued()) as RunRow;
    const finished = await executeSearchRun(deps, run as unknown as Parameters<typeof executeSearchRun>[1]);
    expect(finished.status).toBe('failed');
    expect(finished.error).toContain('search api down');
  });
});

describe('runSearchTick', () => {
  it('advances queued runs until empty', async () => {
    const repos = makeRepos([
      { runId: 'r1', accountId: 'a1', query: 'q1', conditions: COND, status: 'queued', executedQueries: [], resultsCount: 0, newCount: 0, error: null },
      { runId: 'r2', accountId: 'a1', query: 'q2', conditions: COND, status: 'queued', executedQueries: [], resultsCount: 0, newCount: 0, error: null },
    ]);
    const outcome = await runSearchTick({
      searchRuns: repos.searchRuns,
      jobPostings: repos.jobPostings,
      searchClient: searchClient([
        { title: 'Engineer at Acme', url: 'https://acme.com/jobs/1', content: 'Hiring', score: 0.9 },
      ]),
    });
    expect(outcome.advanced).toBe(2);
    expect(outcome.failed).toBe(0);
    expect(repos.searchRuns._rows.every((r: RunRow) => r.status === 'done')).toBe(true);
  });
});
