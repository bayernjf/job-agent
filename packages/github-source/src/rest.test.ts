import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Octokit } from 'octokit';
import {
  fetchPublicEventsRest,
  fetchRepoCommitsCached,
  HttpCache,
  isNotModifiedError,
  parseRestCommits,
  summarizeGhEvents,
  type RestCommitRow,
} from './rest.js';

const FIXTURES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../tests/fixtures/github',
);
function load<T>(name: string): T {
  return JSON.parse(readFileSync(path.join(FIXTURES, name), 'utf8')) as T;
}

describe('parseRestCommits', () => {
  it('maps REST commit rows to AnalyzerCommit', () => {
    const rows = load<RestCommitRow[]>('rest-commits.json');
    const commits = parseRestCommits(rows, 'dev-strong', 'web-platform');
    expect(commits).toHaveLength(2);
    expect(commits[0]!.oid).toBe(rows[0]!.sha);
    expect(commits[0]!.authorEmail).toBe('dev.strong@example.com');
    expect(commits[0]!.messageHeadline).toBe('fix: REST fallback for commit history');
  });
});

describe('isNotModifiedError', () => {
  it('detects HTTP 304 errors', () => {
    expect(isNotModifiedError({ status: 304 })).toBe(true);
    expect(isNotModifiedError(new Error('boom'))).toBe(false);
    expect(isNotModifiedError(null)).toBe(false);
  });
});

describe('public events summary (plan B-1)', () => {
  it('summarizes rows into breadth, type counts and UTC window, filters other actors', () => {
    const rows = [
      { type: 'PushEvent', actor: { login: 'alice' }, repo: { name: 'alice/a' }, created_at: '2026-04-01T04:00:00Z' },
      { type: 'PushEvent', actor: { login: 'alice' }, repo: { name: 'alice/a' }, created_at: '2026-04-02T04:00:00Z' },
      { type: 'PullRequestReviewEvent', actor: { login: 'alice' }, repo: { name: 'org/b' }, created_at: '2026-04-03T04:00:00Z' },
      { type: 'PushEvent', actor: { login: 'bob' }, repo: { name: 'bob/x' }, created_at: '2026-04-03T04:00:00Z' },
    ];
    const s = summarizeGhEvents(rows, 'alice');
    expect(s).not.toBeNull();
    expect(s?.totalEvents).toBe(3);
    expect(s?.distinctRepoCount).toBe(2);
    expect(s?.eventTypeCounts).toEqual({ PushEvent: 2, PullRequestReviewEvent: 1 });
    expect(s?.since).toBe('2026-04-01T04:00:00Z');
    expect(s?.until).toBe('2026-04-03T04:00:00Z');
    expect(summarizeGhEvents([], 'alice')).toBeNull();
  });

  it('fetchPublicEventsRest requests page 1 with per_page 100', async () => {
    let route = '';
    let params: Record<string, unknown> = {};
    const octokit = {
      request: async (r: string, p: Record<string, unknown>) => {
        route = r;
        params = p;
        return { data: [] };
      },
    } as unknown as Octokit;
    const data = await fetchPublicEventsRest(octokit, 'alice');
    expect(route).toBe('GET /users/{username}/events/public');
    expect(params).toMatchObject({ username: 'alice', per_page: 100 });
    expect(data).toEqual([]);
  });
});

describe('fetchRepoCommitsCached', () => {
  it('stores etag on first call and serves 304 from cache on second', async () => {
    const cache = new HttpCache();
    let requests = 0;
    const body = load<RestCommitRow[]>('rest-commits.json');

    const octokit = {
      request: async (_route: string, params: { owner: string; repo: string; headers?: Record<string, string> }) => {
        requests += 1;
        if (params.headers?.['If-None-Match']) {
          const err = new Error('Not Modified') as Error & { status: number };
          err.status = 304;
          throw err;
        }
        return { headers: { etag: '"v1"' }, data: body };
      },
    } as unknown as Octokit;

    const first = await fetchRepoCommitsCached(octokit, cache, 'dev-strong', 'web-platform');
    expect(first.fromCache).toBe(false);
    expect(first.commits).toHaveLength(2);

    const second = await fetchRepoCommitsCached(octokit, cache, 'dev-strong', 'web-platform');
    expect(second.fromCache).toBe(true);
    expect(second.commits).toHaveLength(2);
    expect(requests).toBe(2); // 第二次发出条件请求并命中 304，未下载正文
  });

  it('propagates non-304 errors', async () => {
    const octokit = {
      request: async () => {
        throw new Error('network down');
      },
    } as unknown as Octokit;
    await expect(
      fetchRepoCommitsCached(octokit, new HttpCache(), 'dev-strong', 'web-platform'),
    ).rejects.toThrow('network down');
  });
});
