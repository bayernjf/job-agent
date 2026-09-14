import { AbilityProfileSchema } from '@jobagent/shared';
import { analyze } from '@jobagent/analyzer-core';
import { describe, expect, it, vi } from 'vitest';
import { GiteeSource, GiteeSourceError } from './index.js';
import type {
  GiteeCommitRaw,
  GiteeEventRaw,
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

// events 行为流夹具：一条 PushEvent（采样 top8 之外的组织/其他仓，时间最晚）+ 一条非 Push 事件
const EVENTS: GiteeEventRaw[] = [
  {
    id: 'ev1',
    type: 'PushEvent',
    actor: { login: 'alice' },
    repo: { full_name: 'alice/outside-top-repos' },
    created_at: '2026-05-01T08:00:00+08:00',
    payload: {
      commits: [
        { sha: 'ddd444', message: 'event-only commit', author: { name: 'Plaintext Name', email: 'secret@qq.com' } },
      ],
    },
  },
  {
    id: 'ev2',
    type: 'IssueCommentEvent',
    actor: { login: 'alice' },
    repo: { full_name: 'alice/core' },
    created_at: '2026-05-01T09:00:00+08:00',
    payload: {},
  },
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
    // events URL 含子串 "/users/alice"，其路由必须排在 "/users/alice" 之前；默认空事件流
    if (url.includes('/events/public')) return json([]);
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

    // L1：只采集非归档的 core；PR/Issue 按作者过滤（默认 events 为空，不补 commit）
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

    // user(1)+repos(1)+core 的 commits/pulls/issues(各1)+events(1) = 6 次请求
    expect(meta.budgetUsed.restCalls).toBe(6);
    expect(meta.eventsFetched).toBe(0);
    expect(meta.eventCommitsAdded).toBe(0);

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

describe('GiteeSource events behavior stream (§4.11)', () => {
  it('fills sampled-missing recent commits from PushEvents, strips PII, advances window', async () => {
    const f = routerFetch({ '/events/public': () => json(EVENTS) });
    const { input, evidence, meta } = await makeSource(f).collect('alice');

    // 采样 2 条 + events 补 1 条（IssueCommentEvent 不产生 commit）
    expect(input.commits.map((c) => c.oid).sort()).toEqual(['aaa111', 'bbb222', 'ddd444']);
    const filled = input.commits.find((c) => c.oid === 'ddd444');
    expect(filled).toMatchObject({
      repoName: 'alice/outside-top-repos',
      authorName: 'alice',
      authorEmail: null, // payload 明文邮箱被剥离
    });
    expect(input.contributions.totalCommitContributions).toBe(3);
    expect(evidence.some((e) => e.evidenceId === 'commit:alice/outside-top-repos:ddd444')).toBe(true);

    // events 时间最晚（2026-05-01T08:00+08 → 00:00Z）→ dataWindow.until 被推进
    expect(input.dataWindow.until).toBe('2026-05-01T00:00:00.000Z');
    expect(meta.eventsFetched).toBe(2);
    expect(meta.eventCommitsAdded).toBe(1);
  });

  it('dedupes an event commit already covered by sampling (same repo:oid), sampled wins', async () => {
    const dupEvents: GiteeEventRaw[] = [
      {
        type: 'PushEvent',
        actor: { login: 'alice' },
        repo: { full_name: 'alice/core' },
        created_at: '2026-05-01T08:00:00+08:00',
        payload: { commits: [{ sha: 'aaa111' }] },
      },
    ];
    const f = routerFetch({ '/events/public': () => json(dupEvents) });
    const { input, meta } = await makeSource(f).collect('alice');
    expect(input.commits).toHaveLength(2); // aaa111 已在采样中，不重复
    expect(meta.eventCommitsAdded).toBe(0);
    // 采样优先：保留采样的 03-01 时间，而非 events 的 05-01
    expect(input.commits.find((c) => c.oid === 'aaa111')?.committedAt).toBe('2026-03-01T02:00:00.000Z');
  });

  it('records missing:events but keeps L0/L1 results when the events endpoint fails', async () => {
    const f = routerFetch({ '/events/public': () => new Response(null, { status: 500 }) });
    const { input, meta } = await makeSource(f).collect('alice');
    expect(input.commits).toHaveLength(2);
    expect(input.missing).toContain('events');
    expect(meta.eventsFetched).toBe(0);
  });

  it('requests the events stream exactly once (no pagination)', async () => {
    const calls: string[] = [];
    const inner = routerFetch();
    const f: typeof fetch = (async (url: string) => {
      calls.push(url);
      return inner(url);
    }) as typeof fetch;
    await makeSource(f).collect('alice');
    expect(calls.filter((u) => u.includes('/events/public'))).toHaveLength(1);
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

describe('GiteeSource org-owned repo ownerLogin', () => {
  it('uses repo.ownerLogin (not caller login) for L1 endpoints', async () => {
    const calls: string[] = [];
    const orgRepos: GiteeRepoRaw[] = [
      { ...REPOS[0]!, owner: { login: 'someorg' }, html_url: 'https://gitee.com/someorg/core' },
    ];
    const f: typeof fetch = (async (url: string) => {
      calls.push(url);
      // events URL 含子串 "/users/alice"，其路由必须排在前面
      if (url.includes('/events/public')) return json([]);
      if (url.includes('/users/alice/repos')) return json(orgRepos);
      if (url.includes('/users/alice')) return json(USER);
      if (url.includes('/repos/someorg/core/commits')) return json(COMMITS);
      if (url.includes('/repos/someorg/core/pulls')) return json(PULLS);
      if (url.includes('/repos/someorg/core/issues')) return json(ISSUES);
      return new Response(`unexpected ${url}`, { status: 500 });
    }) as typeof fetch;
    const collected = await makeSource(f).collect('alice');
    expect(collected.input.repos[0]!.ownerLogin).toBe('someorg');
    expect(calls.some((u) => u.includes('/repos/someorg/core/commits'))).toBe(true);
    expect(calls.some((u) => u.includes('/repos/alice/core/commits'))).toBe(false);
  });
});
