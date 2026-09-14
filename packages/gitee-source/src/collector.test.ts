import { AbilityProfileSchema } from '@jobagent/shared';
import { analyze } from '@jobagent/analyzer-core';
import { describe, expect, it, vi } from 'vitest';
import { GiteeSource, GiteeSourceError } from './index.js';
import type {
  GiteeCommitRaw,
  GiteeIssueRaw,
  GiteePullRaw,
  GiteeRepoRaw,
  GiteeUserRaw,
} from './types.js';

const silentLog = { info() {}, warn() {}, error() {} };
const noSleep = async (): Promise<void> => {};

const USER: GiteeUserRaw = {
  login: 'alice',
  name: 'Alice',
  avatar_url: 'https://gitee.com/assets/a.png',
  html_url: 'https://gitee.com/alice',
  bio: 'developer',
  company: 'X',
  location: 'CN',
  email: 'alice@example.com',
  created_at: '2024-01-01T00:00:00+08:00',
  followers: 5,
  following: 3,
  public_repos: 3,
};

const REPOS: GiteeRepoRaw[] = [
  {
    name: 'core',
    html_url: 'https://gitee.com/alice/core',
    owner: { login: 'alice' },
    fork: false,
    archived: false,
    language: 'TypeScript',
    description: 'main project',
    stargazers_count: 10,
    forks_count: 2,
    pushed_at: '2026-03-01T10:00:00+08:00',
    created_at: '2024-01-02T10:00:00+08:00',
  },
  {
    name: 'archived-old',
    owner: { login: 'alice' },
    archived: true,
    stargazers_count: 0,
    forks_count: 0,
    created_at: '2023-01-01T00:00:00+08:00',
  },
  {
    name: 'forked-copy',
    owner: { login: 'alice' },
    fork: true,
    created_at: '2025-01-01T00:00:00+08:00',
  },
];

const COMMITS: GiteeCommitRaw[] = [
  {
    sha: 'aaa111',
    commit: { message: 'init\nbody', author: { name: 'Plaintext Name', email: 'secret@example.com', date: '2026-03-01T10:00:00+08:00' } },
    author: { login: 'alice' },
  },
  {
    sha: 'bbb222',
    commit: { message: 'fix', author: { name: 'Plaintext Name', email: 'secret@example.com', date: '2026-02-01T09:00:00+08:00' } },
    author: { login: 'alice' },
  },
];

const PULLS: GiteePullRaw[] = [
  {
    number: 1,
    title: 'feature',
    html_url: 'https://gitee.com/alice/core/pulls/1',
    state: 'merged',
    created_at: '2026-03-02T10:00:00+08:00',
    merged_at: '2026-03-03T10:00:00+08:00',
    user: { login: 'alice' },
  },
  { number: 2, title: 'someone-else', state: 'open', created_at: '2026-03-02T10:00:00+08:00', user: { login: 'bob' } },
];

const ISSUES: GiteeIssueRaw[] = [
  { number: 5, title: 'bug', html_url: 'https://gitee.com/alice/core/issues/5', state: 'open', created_at: '2026-03-04T10:00:00+08:00', user: { login: 'alice' } },
  { number: 'I7', ident: 'I7', title: 'tracking', state: 'progressing', created_at: '2026-03-05T10:00:00+08:00', user: { login: 'alice' } },
  { number: 9, title: 'theirs', state: 'open', created_at: '2026-03-04T10:00:00+08:00', user: { login: 'carol' } },
];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

/** 路由型 fake fetch：零真实网络，返回脱敏录制夹具 */
function routerFetch(overrides?: Record<string, () => Response>): typeof fetch {
  return (async (url: string) => {
    if (overrides) {
      for (const [needle, handler] of Object.entries(overrides)) {
        if (url.includes(needle)) return handler();
      }
    }
    if (url.includes('/users/alice/repos')) return json(REPOS);
    if (url.includes('/users/alice')) return json(USER);
    if (url.includes('/repos/alice/core/commits')) return json(COMMITS);
    if (url.includes('/repos/alice/core/pulls')) return json(PULLS);
    if (url.includes('/repos/alice/core/issues')) return json(ISSUES);
    return new Response(`unexpected ${url}`, { status: 500 });
  }) as typeof fetch;
}

function makeSource(fetchImpl: typeof fetch, budget?: { restCalls: number }): GiteeSource {
  return new GiteeSource({ fetch: fetchImpl, log: silentLog, sleep: noSleep, budget });
}

describe('GiteeSource.collect full happy path', () => {
  it('maps to AnalyzerInput, cleans PII, marks missing, and flows through analyzer', async () => {
    const collected = await makeSource(routerFetch()).collect('alice');
    const { input, evidence, meta } = collected;

    // L0：fork 被过滤、archived 保留但不进 L1
    expect(input.repos.map((r) => r.name)).toEqual(['core', 'archived-old']);
    expect(input.subject.email).toBeNull();

    // L1：只采集非归档的 core；PR/Issue 按作者过滤
    expect(input.commits).toHaveLength(2);
    expect(input.commits.every((c) => c.authorEmail === null && c.authorName === 'alice')).toBe(true);
    expect(input.pullRequests).toHaveLength(1);
    expect(input.pullRequests[0]!.state).toBe('MERGED');
    expect(input.issues).toHaveLength(2);

    // Gitee 恒无 PR 增删行 → 显式缺失标注
    expect(input.missing).toContain('pr_code_stats');

    // contributions 由采样窗口自聚合
    expect(input.contributions).toMatchObject({
      totalCommitContributions: 2,
      totalPullRequestContributions: 1,
      totalIssueContributions: 2,
      totalRepositoryContributions: 2,
    });

    // 证据全部来自 gitee，且关键 evidenceId 可回溯
    expect(evidence.every((e) => e.sourcePlatform === 'gitee')).toBe(true);
    const ids = new Set(evidence.map((e) => e.evidenceId));
    for (const id of [
      'user:alice',
      'repo:alice/core',
      'pr:alice/core:1',
      'issue:alice/core:5',
      'commit:alice/core:aaa111',
    ]) {
      expect(ids.has(id)).toBe(true);
    }

    // user(1)+repos(1)+core 的 commits/pulls/issues(各1) = 5 次请求
    expect(meta.budgetUsed.restCalls).toBe(5);

    // 端到端过 analyzer 内核：平台标识正确、画像通过 schema
    const profile = analyze(input, { profileId: 'gitee-test-1', platform: 'gitee' });
    expect(profile.subject.platform).toBe('gitee');
    expect(AbilityProfileSchema.safeParse(profile).success).toBe(true);
  });

  it('commits respect deterministic chronological ordering', async () => {
    const collected = await makeSource(routerFetch()).collect('alice');
    const dates = collected.input.commits.map((c) => c.committedAt);
    expect(dates).toEqual([...dates].sort());
  });
});

describe('GiteeSource error handling', () => {
  it('maps 404 on user to not_found', async () => {
    const f = routerFetch({ '/users/alice': () => new Response(null, { status: 404 }) });
    await expect(makeSource(f).collect('alice')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('records a failed L1 slice in missing but finishes the rest', async () => {
    const f = routerFetch({ '/commits': () => new Response(null, { status: 500 }) });
    const collected = await makeSource(f).collect('alice');
    expect(collected.input.commits).toHaveLength(0);
    expect(collected.input.pullRequests).toHaveLength(1);
    expect(collected.input.missing).toContain('commits:alice/core');
  });

  it('throws budget_exhausted when the request cap is hit', async () => {
    const f = routerFetch();
    await expect(makeSource(f, { restCalls: 1 }).collect('alice')).rejects.toBeInstanceOf(GiteeSourceError);
  });
});
