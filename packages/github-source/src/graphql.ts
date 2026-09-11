/**
 * GraphQL 查询构造与响应解析（纯函数，便于用脱敏夹具做单测）。
 * 设计：L0 一次批量查询（user + repos + 贡献概览）；L1 按 repo 取最近提交 +
 * 账号发起的 PR/Issue 时序。
 */

import type { AnalyzerCommit, AnalyzerInput, AnalyzerIssue, AnalyzerPullRequest } from '@jobagent/analyzer-core';
import type { L0Data } from './types.js';

// ---------- L0 ----------

export interface L0RepoNode {
  name: string;
  url: string;
  isFork: boolean;
  isArchived: boolean;
  primaryLanguage: { name: string } | null;
  description: string | null;
  stargazerCount: number;
  forkCount: number;
  pushedAt: string;
  createdAt: string;
  repositoryTopics: { nodes: Array<{ topic: { name: string } }> };
}

export interface L0GraphqlResponse {
  user: {
    id: string;
    login: string;
    name: string | null;
    avatarUrl: string;
    url: string;
    bio: string | null;
    company: string | null;
    location: string | null;
    createdAt: string;
    followers: { totalCount: number };
    following: { totalCount: number };
    repositories: { totalCount: number; nodes: L0RepoNode[] };
    contributionsCollection: {
      totalCommitContributions: number;
      totalPullRequestContributions: number;
      totalIssueContributions: number;
      totalRepositoryContributions: number;
      contributionCalendar: { weeks: Array<{ contributionDays: Array<{ date: string; contributionCount: number }> }> };
    };
  } | null;
}

export const L0_QUERY = /* GraphQL */ `
  query UserL0($login: String!) {
    user(login: $login) {
      id
      login
      name
      avatarUrl
      url
      bio
      company
      location
      createdAt
      followers { totalCount }
      following { totalCount }
      repositories(first: 100, orderBy: { field: PUSHED_AT, direction: DESC }, isFork: false) {
        totalCount
        nodes {
          name
          url
          isFork
          isArchived
          primaryLanguage { name }
          description
          stargazerCount
          forkCount
          pushedAt
          createdAt
          repositoryTopics(first: 10) { nodes { topic { name } } }
        }
      }
      contributionsCollection {
        totalCommitContributions
        totalPullRequestContributions
        totalIssueContributions
        totalRepositoryContributions
        contributionCalendar { weeks { contributionDays { date contributionCount } } }
      }
    }
  }
`;

/** 按 YYYY-MM 聚合贡献日历，得到逐月活跃度（L1 节奏/突发信号的输入） */
export function aggregateContributionMonths(
  weeks: Array<{ contributionDays: Array<{ date: string; contributionCount: number }> }>,
): Array<{ year: number; month: number; count: number }> {
  const byMonth = new Map<string, number>();
  for (const week of weeks) {
    for (const day of week.contributionDays) {
      const key = day.date.slice(0, 7); // YYYY-MM
      byMonth.set(key, (byMonth.get(key) ?? 0) + day.contributionCount);
    }
  }
  return [...byMonth.entries()]
    .map(([key, count]) => {
      const [year, month] = key.split('-').map(Number);
      return { year: year ?? 0, month: month ?? 0, count };
    })
    .sort((a, b) => a.year - b.year || a.month - b.month);
}

/** 解析 L0 响应；账号不存在（user 为 null）返回 null，由调用方标注 not_found */
export function parseL0Response(raw: L0GraphqlResponse, login: string): L0Data | null {
  const user = raw.user;
  if (!user) return null;

  const repos: AnalyzerInput['repos'] = user.repositories.nodes.map((r) => ({
    name: r.name,
    url: r.url,
    isFork: r.isFork,
    isArchived: r.isArchived,
    primaryLanguage: r.primaryLanguage?.name ?? null,
    topics: r.repositoryTopics.nodes.map((t) => t.topic.name),
    description: r.description,
    stargazerCount: r.stargazerCount,
    forkCount: r.forkCount,
    pushedAt: r.pushedAt,
    createdAt: r.createdAt,
  }));

  const months = aggregateContributionMonths(user.contributionsCollection.contributionCalendar.weeks);
  const contributions = {
    totalCommitContributions: user.contributionsCollection.totalCommitContributions,
    totalPullRequestContributions: user.contributionsCollection.totalPullRequestContributions,
    totalIssueContributions: user.contributionsCollection.totalIssueContributions,
    totalRepositoryContributions: user.contributionsCollection.totalRepositoryContributions,
    contributionMonths: months,
  };

  const pushedDates = repos.map((r) => r.pushedAt).filter((d): d is string => Boolean(d));
  const latestPush = pushedDates.length > 0 ? [...pushedDates].sort().at(-1)! : user.createdAt;
  const dataWindow = {
    since: user.createdAt,
    until: latestPush,
  };

  return {
    subject: {
      login: user.login,
      displayName: user.name ?? null,
      avatarUrl: user.avatarUrl,
      profileUrl: user.url,
      bio: user.bio ?? null,
      company: user.company ?? null,
      location: user.location ?? null,
      email: null, // 公开 email 由 REST 补充（fetchUserEmailRest），collector 覆盖
      createdAt: user.createdAt,
      followers: user.followers.totalCount,
      following: user.following.totalCount,
      publicRepos: user.repositories.totalCount,
    },
    repos,
    contributions,
    dataWindow,
  };
}

// ---------- L1：commits / PRs / Issues ----------

export interface RepoCommitsResponse {
  repository: {
    defaultBranchRef: {
      target: {
        history: {
          nodes: Array<{
            oid: string;
            committedDate: string;
            messageHeadline: string;
            author: { name: string | null; email: string | null } | null;
          }>;
        };
      };
    } | null;
  } | null;
}

export const REPO_COMMITS_QUERY = /* GraphQL */ `
  query RepoCommits($owner: String!, $name: String!, $first: Int!) {
    repository(owner: $owner, name: $name) {
      defaultBranchRef {
        target {
          ... on Commit {
            history(first: $first) {
              nodes {
                oid
                committedDate
                messageHeadline
                author { name email }
              }
            }
          }
        }
      }
    }
  }
`;

export interface PullRequestsResponse {
  user: {
    pullRequests: {
      nodes: Array<{
        number: number;
        title: string;
        url: string;
        state: 'OPEN' | 'MERGED' | 'CLOSED';
        createdAt: string;
        mergedAt: string | null;
        repository: { nameWithOwner: string; isFork: boolean };
        additions: number;
        deletions: number;
        changedFiles: number;
      }>;
    };
  } | null;
}

export const PULL_REQUESTS_QUERY = /* GraphQL */ `
  query UserPullRequests($login: String!, $first: Int!) {
    user(login: $login) {
      pullRequests(first: $first, orderBy: { field: CREATED_AT, direction: DESC }) {
        nodes {
          number
          title
          url
          state
          createdAt
          mergedAt
          repository { nameWithOwner isFork }
          additions
          deletions
          changedFiles
        }
      }
    }
  }
`;

export interface IssuesResponse {
  user: {
    issues: {
      nodes: Array<{
        number: number;
        title: string;
        url: string;
        state: 'OPEN' | 'CLOSED';
        createdAt: string;
        repository: { nameWithOwner: string };
      }>;
    };
  } | null;
}

export const ISSUES_QUERY = /* GraphQL */ `
  query UserIssues($login: String!, $first: Int!) {
    user(login: $login) {
      issues(first: $first, orderBy: { field: CREATED_AT, direction: DESC }) {
        nodes {
          number
          title
          url
          state
          createdAt
          repository { nameWithOwner }
        }
      }
    }
  }
`;

export function parseRepoCommits(raw: RepoCommitsResponse, owner: string, repoName: string): AnalyzerCommit[] {
  const history = raw.repository?.defaultBranchRef?.target?.history?.nodes ?? [];
  return history
    .filter((c) => Boolean(c?.oid))
    .map((c) => ({
      oid: c.oid,
      committedAt: c.committedDate,
      authorName: c.author?.name ?? null,
      authorEmail: c.author?.email ?? null,
      repoName,
      messageHeadline: c.messageHeadline,
    }));
}

export function parsePullRequests(raw: PullRequestsResponse, login: string): AnalyzerPullRequest[] {
  const nodes = raw.user?.pullRequests?.nodes ?? [];
  return nodes
    .filter((p) => Boolean(p?.number))
    .map((p) => ({
      number: p.number,
      title: p.title,
      url: p.url,
      state: p.state,
      createdAt: p.createdAt,
      mergedAt: p.mergedAt,
      repoNameWithOwner: p.repository.nameWithOwner,
      repoIsFork: p.repository.isFork,
      repoOwnerIsSelf: p.repository.nameWithOwner.split('/')[0] === login,
      additions: p.additions,
      deletions: p.deletions,
      changedFiles: p.changedFiles,
    }));
}

export function parseIssues(raw: IssuesResponse): AnalyzerIssue[] {
  const nodes = raw.user?.issues?.nodes ?? [];
  return nodes
    .filter((i) => Boolean(i?.number))
    .map((i) => ({
      number: i.number,
      title: i.title,
      url: i.url,
      state: i.state,
      createdAt: i.createdAt,
      repoNameWithOwner: i.repository.nameWithOwner,
    }));
}
