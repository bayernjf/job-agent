import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Octokit } from 'octokit';
import {
  fetchRepoCommitsCached,
  HttpCache,
  isNotModifiedError,
  parseRestCommits,
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
