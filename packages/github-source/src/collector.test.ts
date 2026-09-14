import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { GitHubSource, GitHubSourceError } from './collector.js';
import type { L0GraphqlResponse } from './graphql.js';

const FIXTURES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../tests/fixtures/github',
);
function load<T>(name: string): T {
  return JSON.parse(readFileSync(path.join(FIXTURES, name), 'utf8')) as T;
}

/** 按 GraphQL query 关键字 + REST 路由返回夹具的 fake fetch（不打真实 GitHub） */
function fakeFetch(
  opts: {
    l0Mutate?: (l0: L0GraphqlResponse) => void;
    repoOwners?: string[];
    eventsRows?: unknown[];
    eventsFail?: boolean;
  } = {},
): typeof fetch {
  return async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const body = typeof init?.body === 'string' ? init.body : '';
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    let payload: unknown = null;

    if (url.includes('/graphql')) {
      const variables = JSON.parse(body).variables as { login?: string; name?: string; owner?: string };
      if (body.includes('UserL0')) {
        const login = variables.login ?? '';
        headers['x-ratelimit-cost'] = '20';
        if (login === 'dev-notfound') payload = load<L0GraphqlResponse>('l0-notfound.json');
        else if (login === 'org-account')
          payload = {
            data: { user: null },
            errors: [
              {
                type: 'NOT_FOUND',
                message: "Could not resolve to a User with the login of 'org-account'.",
              },
            ],
          };
        else if (login === 'dev-quiet') payload = load('l0-insufficient.json');
        else if (login === 'dev-suspicious') payload = load('l0-suspicious.json');
        else {
          const raw = load<{ data: L0GraphqlResponse }>('l0-strong.json');
          opts.l0Mutate?.(raw.data);
          payload = raw;
        }
      } else if (body.includes('RepoCommits')) {
        headers['x-ratelimit-cost'] = '3';
        opts.repoOwners?.push(variables.owner ?? '');
        payload =
          variables.name === 'repo-a'
            ? load('repo-commits-mismatch.json')
            : load('repo-commits-strong.json');
      } else if (body.includes('UserPullRequests')) {
        headers['x-ratelimit-cost'] = '5';
        payload = load('pull-requests-strong.json');
      } else if (body.includes('UserIssues')) {
        headers['x-ratelimit-cost'] = '5';
        payload = load('issues-strong.json');
      }
    } else if (url.includes('/events/public')) {
      // events 路由必须排在 /users/ 之前；默认空事件流（不产生 behaviorEvents、不记缺失）
      if (opts.eventsFail) return new Response(null, { status: 404 }); // 404 在 doNotRetry 列表，立即失败不触发退避
      payload = opts.eventsRows ?? [];
    } else if (url.includes('/users/')) {
      payload = load('rest-user.json');
    } else if (url.includes('/commits')) {
      payload = load('rest-commits.json');
      headers['etag'] = '"v1"';
    }

    return new Response(JSON.stringify(payload), { status: 200, headers });
  };
}

const TOKEN = 'test-token';

describe('GitHubSource.collect', () => {
  it('fills input.behaviorEvents from public events with a single page-1 REST call', async () => {
    const eventsRows = [
      { type: 'PushEvent', actor: { login: 'dev-strong' }, repo: { name: 'dev-strong/web-platform' }, created_at: '2026-08-01T04:00:00Z' },
      { type: 'IssueCommentEvent', actor: { login: 'dev-strong' }, repo: { name: 'other/lib' }, created_at: '2026-08-02T04:00:00Z' },
    ];
    const calls: string[] = [];
    const inner = fakeFetch({ eventsRows });
    const counting = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      calls.push(String(input));
      return inner(input, init);
    }) as typeof fetch;
    const source = new GitHubSource({ token: TOKEN, fetch: counting, throttleEnabled: false });
    const result = await source.collect('dev-strong');
    expect(result.input.behaviorEvents).toMatchObject({
      totalEvents: 2,
      distinctRepoCount: 2,
      eventTypeCounts: { PushEvent: 1, IssueCommentEvent: 1 },
    });
    expect(result.meta.missing).not.toContain('events');
    expect(calls.filter((u) => u.includes('/events/public'))).toHaveLength(1); // 只取第 1 页
  });

  it('leaves behaviorEvents undefined (no missing) when events page is empty', async () => {
    const source = new GitHubSource({ token: TOKEN, fetch: fakeFetch(), throttleEnabled: false });
    const result = await source.collect('dev-strong');
    expect(result.input.behaviorEvents).toBeUndefined();
    expect(result.meta.missing).not.toContain('events');
  });

  it('records missing:events but keeps L0/L1 when the events endpoint fails', async () => {
    const source = new GitHubSource({
      token: TOKEN,
      fetch: fakeFetch({ eventsFail: true }),
      throttleEnabled: false,
    });
    const result = await source.collect('dev-strong');
    expect(result.input.behaviorEvents).toBeUndefined();
    expect(result.meta.missing).toContain('events');
    expect(result.input.commits.length).toBeGreaterThan(0); // L0/L1 不受影响
  });

  it('collects L0+L1 for a strong account with evidence and budget meta', async () => {
    const source = new GitHubSource({ token: TOKEN, fetch: fakeFetch(), throttleEnabled: false });
    const result = await source.collect('dev-strong');

    expect(result.input.subject.login).toBe('dev-strong');
    expect(result.input.subject.email).toBe('dev.strong@example.com'); // REST 补充
    expect(result.input.repos.length).toBeGreaterThan(0);
    expect(result.input.commits.length).toBeGreaterThan(0);
    expect(result.input.pullRequests.some((p) => !p.repoOwnerIsSelf)).toBe(true);
    expect(result.evidence.length).toBeGreaterThan(0);
    expect(result.meta.missing).toEqual([]);
    expect(result.meta.budgetUsed.graphqlPoints).toBeGreaterThan(0);
    expect(result.meta.budgetUsed.restCalls).toBeGreaterThan(0);
  });

  it('normalizes an Organization login (user query returns NOT_FOUND) to not_found', async () => {
    const source = new GitHubSource({ token: TOKEN, fetch: fakeFetch(), throttleEnabled: false });
    await expect(source.collect('org-account')).rejects.toMatchObject({
      code: 'not_found',
    } satisfies Partial<GitHubSourceError>);
  });

  it('queries org-owned repositories with their real owner (regression: user.repositories includes org repos)', async () => {
    const repoOwners: string[] = [];
    const source = new GitHubSource({
      token: TOKEN,
      throttleEnabled: false,
      fetch: fakeFetch({
        repoOwners,
        l0Mutate: (l0) => {
          const first = l0.user!.repositories.nodes[0]!;
          first.owner.login = 'some-org';
          first.nameWithOwner = 'some-org/' + first.name;
        },
      }),
    });
    const result = await source.collect('dev-strong');
    expect(repoOwners).toContain('some-org');
    // 提交归属到真实 owner/name，证据 id 可被 analyzer 对齐
    expect(result.input.commits.some((c) => c.repoName.startsWith('some-org/'))).toBe(true);
  });

  it('throws not_found for unknown accounts', async () => {
    const source = new GitHubSource({ token: TOKEN, fetch: fakeFetch(), throttleEnabled: false });
    await expect(source.collect('dev-notfound')).rejects.toMatchObject({
      code: 'not_found',
    } satisfies Partial<GitHubSourceError>);
  });

  it('labels missing data instead of fabricating when budget is exhausted', async () => {
    const source = new GitHubSource({
      token: TOKEN,
      fetch: fakeFetch(),
      throttleEnabled: false,
      budget: { graphqlPoints: 25, restCalls: 1 }, // L0 消耗 20 点后 L1 逐步耗尽
    });
    const result = await source.collect('dev-strong');
    expect(result.meta.missing.length).toBeGreaterThan(0);
    expect(result.meta.budgetUsed.graphqlPoints).toBeLessThanOrEqual(25);
  });

  it('commits respect deterministic ordering', async () => {
    const source = new GitHubSource({ token: TOKEN, fetch: fakeFetch(), throttleEnabled: false });
    const { input } = await source.collect('dev-strong');
    const dates = input.commits.map((c) => c.committedAt);
    expect(dates).toEqual([...dates].sort());
  });
});
