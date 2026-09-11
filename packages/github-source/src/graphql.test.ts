import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  aggregateContributionMonths,
  parseIssues,
  parseL0Response,
  parsePullRequests,
  parseRepoCommits,
  type L0GraphqlResponse,
  type IssuesResponse,
  type PullRequestsResponse,
  type RepoCommitsResponse,
} from './graphql.js';

const FIXTURES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../tests/fixtures/github',
);
function load<T>(name: string): T {
  return JSON.parse(readFileSync(path.join(FIXTURES, name), 'utf8')) as T;
}
/** GraphQL 夹具是 GitHub 原始响应（含 data 包裹层） */
function loadData<T>(name: string): T {
  return load<{ data: T }>(name).data;
}

describe('parseL0Response', () => {
  it('maps a strong account to structured L0 data', () => {
    const raw = loadData<L0GraphqlResponse>('l0-strong.json');
    const l0 = parseL0Response(raw, 'dev-strong');
    expect(l0).not.toBeNull();
    expect(l0!.subject.login).toBe('dev-strong');
    expect(l0!.subject.email).toBeNull(); // email 由 REST 补充
    expect(l0!.repos).toHaveLength(6);
    expect(l0!.repos[0]!.primaryLanguage).toBe('TypeScript');
    expect(l0!.repos[0]!.topics).toContain('react');
    expect(l0!.contributions.totalCommitContributions).toBe(486);
    expect(l0!.dataWindow.since).toBe('2018-03-14T00:00:00Z');
  });

  it('returns null when the account does not exist', () => {
    const raw = loadData<L0GraphqlResponse>('l0-notfound.json');
    expect(parseL0Response(raw, 'ghost')).toBeNull();
  });

  it('maps a low-activity account without inventing data', () => {
    const raw = loadData<L0GraphqlResponse>('l0-insufficient.json');
    const l0 = parseL0Response(raw, 'dev-quiet');
    expect(l0!.repos).toHaveLength(1);
    expect(l0!.repos[0]!.primaryLanguage).toBeNull();
    expect(l0!.contributions.totalCommitContributions).toBe(0);
  });
});

describe('aggregateContributionMonths', () => {
  it('aggregates daily contributions into YYYY-MM buckets sorted ascending', () => {
    const months = aggregateContributionMonths([
      {
        contributionDays: [
          { date: '2026-08-24', contributionCount: 3 },
          { date: '2026-08-31', contributionCount: 4 },
        ],
      },
      {
        contributionDays: [
          { date: '2026-09-01', contributionCount: 6 },
          { date: '2025-12-25', contributionCount: 2 },
        ],
      },
    ]);
    expect(months).toEqual([
      { year: 2025, month: 12, count: 2 },
      { year: 2026, month: 8, count: 7 },
      { year: 2026, month: 9, count: 6 },
    ]);
  });
});

describe('parseRepoCommits', () => {
  it('maps GraphQL commit history to AnalyzerCommit', () => {
    const raw = loadData<RepoCommitsResponse>('repo-commits-strong.json');
    const commits = parseRepoCommits(raw, 'dev-strong', 'web-platform');
    expect(commits).toHaveLength(3);
    expect(commits[0]!.authorName).toBe('Dev Strong');
    expect(commits[0]!.repoName).toBe('web-platform');
    expect(commits[0]!.oid).toHaveLength(40);
  });

  it('returns empty array for a repo without default branch', () => {
    const raw: RepoCommitsResponse = { repository: { defaultBranchRef: null } };
    expect(parseRepoCommits(raw, 'dev-strong', 'empty-repo')).toEqual([]);
  });
});

describe('parsePullRequests', () => {
  it('marks external vs self-owned repos', () => {
    const raw = loadData<PullRequestsResponse>('pull-requests-strong.json');
    const prs = parsePullRequests(raw, 'dev-strong');
    expect(prs).toHaveLength(3);
    expect(prs.find((p) => p.number === 142)!.repoOwnerIsSelf).toBe(false);
    expect(prs.find((p) => p.number === 57)!.repoOwnerIsSelf).toBe(true);
    expect(prs.find((p) => p.number === 143)!.state).toBe('OPEN');
  });
});

describe('parseIssues', () => {
  it('maps issues with repo context', () => {
    const raw = loadData<IssuesResponse>('issues-strong.json');
    const issues = parseIssues(raw);
    expect(issues).toHaveLength(2);
    expect(issues[0]!.repoNameWithOwner).toBe('dev-strong/web-platform');
  });
});
