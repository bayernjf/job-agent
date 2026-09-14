import { describe, expect, it } from 'vitest';
import {
  aggregateCommitMonths,
  buildContributions,
  buildDataWindow,
  mapCommits,
  mapIssues,
  mapPullRequests,
  mapRepos,
  mapSubject,
  toUtc,
} from './mappers.js';
import type {
  GiteeCommitRaw,
  GiteeIssueRaw,
  GiteePullRaw,
  GiteeRepoRaw,
  GiteeUserRaw,
} from './types.js';

describe('toUtc', () => {
  it('converts +08:00 offset to UTC Z', () => {
    expect(toUtc('2026-03-01T10:00:00+08:00')).toBe('2026-03-01T02:00:00.000Z');
  });
  it('returns null for empty/invalid input', () => {
    expect(toUtc(null)).toBeNull();
    expect(toUtc(undefined)).toBeNull();
    expect(toUtc('not-a-date')).toBeNull();
  });
});

describe('mapSubject', () => {
  it('maps fields and never exposes email (PII boundary)', () => {
    const raw: GiteeUserRaw = {
      login: 'alice',
      name: 'Alice',
      avatar_url: 'https://gitee.com/a.png',
      html_url: 'https://gitee.com/alice',
      bio: 'b',
      company: 'X',
      location: 'CN',
      email: 'alice@example.com', // 必须被丢弃
      created_at: '2024-01-01T00:00:00+08:00',
      followers: 5,
      following: 3,
      public_repos: 2,
    };
    const s = mapSubject(raw, 'alice');
    expect(s.email).toBeNull();
    expect(s.createdAt).toBe('2023-12-31T16:00:00.000Z');
    expect(s).toMatchObject({ login: 'alice', displayName: 'Alice', followers: 5, publicRepos: 2 });
  });

  it('falls back to defaults when optional fields are missing', () => {
    const s = mapSubject({ login: 'alice' }, 'alice');
    expect(s.displayName).toBeNull();
    expect(s.avatarUrl).toBeNull();
    expect(s.profileUrl).toBe('https://gitee.com/alice');
    expect(s.createdAt).toBeNull();
    expect(s.followers).toBe(0);
    expect(s.publicRepos).toBe(0);
  });
});

describe('mapRepos', () => {
  it('drops forks and rows without created_at, keeps archived and resolves real owner', () => {
    const rows: GiteeRepoRaw[] = [
      {
        name: 'core',
        owner: { login: 'alice' },
        fork: false,
        archived: false,
        language: 'TypeScript',
        stargazers_count: 10,
        forks_count: 2,
        pushed_at: '2026-03-01T10:00:00+08:00',
        created_at: '2024-01-02T10:00:00+08:00',
      },
      { name: 'forked', owner: { login: 'alice' }, fork: true, created_at: '2024-01-01T00:00:00+08:00' },
      { name: 'archived-old', owner: { login: 'alice' }, archived: true, created_at: '2023-01-01T00:00:00+08:00' },
      { name: 'no-created', owner: { login: 'alice' } },
    ];
    const repos = mapRepos(rows, 'alice');
    expect(repos.map((r) => r.name)).toEqual(['core', 'archived-old']);
    expect(repos[0]!.pushedAt).toBe('2026-03-01T02:00:00.000Z');
    expect(repos[0]!.isFork).toBe(false);
    expect(repos[0]!.topics).toEqual([]);
  });
});

describe('mapCommits (PII cleaning)', () => {
  it('strips author email/plaintext name, uses top-level login, drops dateless rows', () => {
    const rows: GiteeCommitRaw[] = [
      {
        sha: 'aaa111',
        commit: {
          message: 'init\nbody line',
          author: { name: 'Secret Name', email: 'secret@example.com', date: '2026-03-01T10:00:00+08:00' },
        },
        author: { login: 'alice' },
      },
      { sha: 'bbb222', commit: { message: 'fix', author: { date: 'bad-date' } }, author: { login: 'alice' } },
    ];
    const commits = mapCommits(rows, 'alice/core');
    expect(commits).toHaveLength(1);
    expect(commits[0]).toMatchObject({
      oid: 'aaa111',
      authorEmail: null,
      authorName: 'alice',
      repoName: 'alice/core',
      messageHeadline: 'init', // 只取首行
      committedAt: '2026-03-01T02:00:00.000Z',
    });
  });

  it('handles anonymous commits with no top-level author login', () => {
    const rows: GiteeCommitRaw[] = [
      {
        sha: 'ccc333',
        commit: { message: 'authored anonymously', author: { date: '2026-03-01T10:00:00+08:00' } },
        author: null,
      },
    ];
    const commits = mapCommits(rows, 'alice/core');
    expect(commits).toHaveLength(1);
    expect(commits[0]!.authorName).toBeNull();
    expect(commits[0]!.authorEmail).toBeNull();
  });
});

describe('mapPullRequests', () => {
  it('keeps only self-authored PRs, maps state and zero-fills code stats', () => {
    const rows: GiteePullRaw[] = [
      {
        number: 1,
        title: 'feature',
        html_url: 'https://gitee.com/alice/core/pulls/1',
        state: 'merged',
        created_at: '2026-03-02T10:00:00+08:00',
        merged_at: '2026-03-03T10:00:00+08:00',
        user: { login: 'alice' },
      },
      { number: 2, title: 'other', state: 'open', created_at: '2026-03-02T10:00:00+08:00', user: { login: 'bob' } },
    ];
    const prs = mapPullRequests(rows, 'alice', 'alice/core');
    expect(prs).toHaveLength(1);
    expect(prs[0]).toMatchObject({
      number: 1,
      state: 'MERGED',
      mergedAt: '2026-03-03T02:00:00.000Z',
      repoOwnerIsSelf: true,
      additions: 0,
      deletions: 0,
      changedFiles: 0,
    });
  });

  it('marks external-repo PRs as not self-owned', () => {
    const prs = mapPullRequests(
      [{ number: 3, state: 'open', created_at: '2026-03-02T10:00:00+08:00', user: { login: 'alice' } }],
      'alice',
      'some-org/shared',
    );
    expect(prs[0]!.repoOwnerIsSelf).toBe(false);
    expect(prs[0]!.url).toBe('https://gitee.com/some-org/shared/pulls/3');
  });
});

describe('mapIssues', () => {
  it('keeps self-authored issues, maps state, falls back to sequence for non-numeric ident', () => {
    const rows: GiteeIssueRaw[] = [
      { number: 5, title: 'bug', state: 'open', created_at: '2026-03-04T10:00:00+08:00', user: { login: 'alice' } },
      { number: 'I7', ident: 'I7', title: 'progress', state: 'progressing', created_at: '2026-03-05T10:00:00+08:00', user: { login: 'alice' } },
      { number: 9, title: 'theirs', state: 'open', created_at: '2026-03-04T10:00:00+08:00', user: { login: 'carol' } },
    ];
    const issues = mapIssues(rows, 'alice', 'alice/core');
    expect(issues).toHaveLength(2);
    expect(issues[0]!.number).toBe(5);
    expect(issues[0]!.state).toBe('OPEN');
    expect(issues[1]!.number).toBe(2); // 非数字 ident 回退为本次列表 1 基序号
    expect(issues[1]!.url).toContain('/issues/I7');
    expect(issues[1]!.state).toBe('OPEN');
  });
});

describe('aggregation', () => {
  const commits = mapCommits(
    [
      { sha: 'c1', commit: { author: { date: '2026-02-01T09:00:00+08:00' } }, author: { login: 'alice' } },
      { sha: 'c2', commit: { author: { date: '2026-03-01T09:00:00+08:00' } }, author: { login: 'alice' } },
      { sha: 'c3', commit: { author: { date: '2026-03-02T09:00:00+08:00' } }, author: { login: 'alice' } },
    ],
    'alice/core',
  );
  const repos = mapRepos(
    [{ name: 'core', owner: { login: 'alice' }, created_at: '2024-01-01T00:00:00+08:00', pushed_at: '2026-03-02T09:00:00+08:00' }],
    'alice',
  );

  it('aggregates commit months in chronological order', () => {
    expect(aggregateCommitMonths(commits)).toEqual([
      { year: 2026, month: 2, count: 1 },
      { year: 2026, month: 3, count: 2 },
    ]);
  });

  it('builds contributions from sampled window', () => {
    const c = buildContributions(commits, [{ number: 1 } as never], [{ number: 2 } as never], repos);
    expect(c).toMatchObject({
      totalCommitContributions: 3,
      totalPullRequestContributions: 1,
      totalIssueContributions: 1,
      totalRepositoryContributions: 1,
    });
  });

  it('builds dataWindow from account creation to latest activity', () => {
    const w = buildDataWindow('2023-12-31T16:00:00.000Z', repos, commits);
    expect(w.since).toBe('2023-12-31T16:00:00.000Z');
    expect(w.until).toBe('2026-03-02T01:00:00.000Z');
  });
});
