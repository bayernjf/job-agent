/**
 * 测试辅助：构造确定性的 AnalyzerInput（证据与数据同步生成）。
 * 仅测试使用；被 tsconfig.build.json exclude，不进入 dist。
 */

import type { EvidenceItem } from '@jobagent/shared';
import type {
  AnalyzerCommit,
  AnalyzerInput,
  AnalyzerIssue,
  AnalyzerPullRequest,
  AnalyzerRepo,
} from './input.js';

const COLLECTED_AT = '2026-09-11T00:00:00.000Z';

export interface InputSeed {
  login?: string;
  displayName?: string | null;
  email?: string | null;
  createdAt?: string | null;
  repos?: AnalyzerRepo[];
  commits?: AnalyzerCommit[];
  pullRequests?: AnalyzerPullRequest[];
  issues?: AnalyzerIssue[];
  contributions?: AnalyzerInput['contributions'];
  collectedAt?: string;
  missing?: string[];
  behaviorEvents?: AnalyzerInput['behaviorEvents'];
}

const defaultRepos: AnalyzerRepo[] = [
  {
    name: 'web-platform',
    ownerLogin: 'dev-strong',
    url: 'https://github.com/dev-strong/web-platform',
    isFork: false,
    isArchived: false,
    primaryLanguage: 'TypeScript',
    topics: ['react', 'hono', 'api'],
    description: 'Full-stack web platform',
    stargazerCount: 214,
    forkCount: 18,
    pushedAt: '2026-08-20T00:00:00Z',
    createdAt: '2022-01-10T00:00:00Z',
  },
  {
    name: 'data-pipeline',
    ownerLogin: 'dev-strong',
    url: 'https://github.com/dev-strong/data-pipeline',
    isFork: false,
    isArchived: false,
    primaryLanguage: 'Python',
    topics: ['data', 'ml'],
    description: 'ETL pipeline',
    stargazerCount: 88,
    forkCount: 9,
    pushedAt: '2026-07-02T00:00:00Z',
    createdAt: '2023-05-01T00:00:00Z',
  },
  {
    name: 'blog',
    ownerLogin: 'dev-strong',
    url: 'https://github.com/dev-strong/blog',
    isFork: false,
    isArchived: false,
    primaryLanguage: 'TypeScript',
    topics: ['astro'],
    description: 'Astro blog',
    stargazerCount: 4,
    forkCount: 0,
    pushedAt: '2026-04-03T00:00:00Z',
    createdAt: '2024-08-01T00:00:00Z',
  },
  {
    name: 'go-cli-tool',
    ownerLogin: 'dev-strong',
    url: 'https://github.com/dev-strong/go-cli-tool',
    isFork: false,
    isArchived: false,
    primaryLanguage: 'Go',
    topics: ['cli'],
    description: 'CLI tooling',
    stargazerCount: 12,
    forkCount: 2,
    pushedAt: '2026-05-11T00:00:00Z',
    createdAt: '2024-02-18T00:00:00Z',
  },
];

function defaultCommits(login: string, displayName: string): AnalyzerCommit[] {
  // author email 固定用账号默认邮箱：seed.email 变化只影响 subject.email（用于 mismatch 测试）
  const email = 'dev.strong@example.com';
  const months = ['2025-10', '2025-11', '2026-01', '2026-03', '2026-06', '2026-08'];
  return months.map((m, i) => ({
    oid: `${String(i + 1).padStart(2, '0')}aabbccddeeff00112233445566778899aabbccdd`,
    committedAt: `${m}-15T10:00:00Z`,
    authorName: displayName,
    authorEmail: email,
    repoName: i % 2 === 0 ? 'dev-strong/web-platform' : 'dev-strong/data-pipeline',
    messageHeadline: `feat: change ${i + 1}`,
  }));
}

const defaultPullRequests: AnalyzerPullRequest[] = [
  {
    number: 142,
    title: 'feat: add contribution calendar aggregation',
    url: 'https://github.com/other-org/awesome-project/pull/142',
    state: 'MERGED',
    createdAt: '2026-06-15T08:00:00Z',
    mergedAt: '2026-06-20T12:00:00Z',
    repoNameWithOwner: 'other-org/awesome-project',
    repoIsFork: false,
    repoOwnerIsSelf: false,
    additions: 210,
    deletions: 45,
    changedFiles: 6,
  },
  {
    number: 57,
    title: 'fix: migrate storage layer',
    url: 'https://github.com/dev-strong/web-platform/pull/57',
    state: 'MERGED',
    createdAt: '2026-05-02T09:30:00Z',
    mergedAt: '2026-05-03T10:00:00Z',
    repoNameWithOwner: 'dev-strong/web-platform',
    repoIsFork: false,
    repoOwnerIsSelf: true,
    additions: 88,
    deletions: 12,
    changedFiles: 4,
  },
];

const defaultIssues: AnalyzerIssue[] = [
  {
    number: 13,
    title: 'question: how to verify commit authorship?',
    url: 'https://github.com/dev-strong/web-platform/issues/13',
    state: 'OPEN',
    createdAt: '2026-08-22T02:00:00Z',
    repoNameWithOwner: 'dev-strong/web-platform',
  },
];

function commitEvidence(c: AnalyzerCommit): EvidenceItem {
  return {
    evidenceId: `commit:${c.repoName}:${c.oid}`,
    sourcePlatform: 'github',
    sourceType: 'commit',
    url: `https://github.com/${c.repoName}/commit/${c.oid}`,
    occurredAt: c.committedAt,
    layer: 'L1',
    claim: c.messageHeadline,
    rawRef: `${c.repoName}#${c.oid}`,
  };
}

function prEvidence(p: AnalyzerPullRequest): EvidenceItem {
  return {
    evidenceId: `pr:${p.repoNameWithOwner}:${p.number}`,
    sourcePlatform: 'github',
    sourceType: 'pr',
    url: p.url,
    occurredAt: p.createdAt,
    layer: 'L1',
    claim: p.title,
    rawRef: `${p.repoNameWithOwner}#${p.number}`,
  };
}

function issueEvidence(i: AnalyzerIssue): EvidenceItem {
  return {
    evidenceId: `issue:${i.repoNameWithOwner}:${i.number}`,
    sourcePlatform: 'github',
    sourceType: 'issue',
    url: i.url,
    occurredAt: i.createdAt,
    layer: 'L1',
    claim: i.title,
    rawRef: `${i.repoNameWithOwner}#${i.number}`,
  };
}

/** 默认是"强账号"（author 一致、跨 10 个月、有外部 merged PR、多语言）；按 seed 覆盖生成变体 */
export function buildInput(seed: InputSeed = {}): AnalyzerInput {
  const login = seed.login ?? 'dev-strong';
  const displayName = seed.displayName ?? 'Dev Strong';
  const email = 'email' in seed ? (seed.email ?? null) : 'dev.strong@example.com';
  const collectedAt = seed.collectedAt ?? COLLECTED_AT;
  const repos = seed.repos ?? defaultRepos;
  const commits = seed.commits ?? defaultCommits(login, displayName);
  const pullRequests = seed.pullRequests ?? defaultPullRequests;
  const issues = seed.issues ?? defaultIssues;
  const contributions = seed.contributions ?? {
    totalCommitContributions: 486,
    totalPullRequestContributions: 34,
    totalIssueContributions: 21,
    totalRepositoryContributions: 4,
    contributionMonths: [
      { year: 2025, month: 10, count: 8 },
      { year: 2026, month: 8, count: 12 },
    ],
  };

  const evidence: EvidenceItem[] = [
    {
      evidenceId: `user:${login}`,
      sourcePlatform: 'github',
      sourceType: 'contribution',
      url: `https://github.com/${login}`,
      occurredAt: seed.createdAt ?? '2018-03-14T00:00:00Z',
      layer: 'L0',
      claim: `GitHub 账号 ${login}`,
      rawRef: login,
    },
    ...repos.map((r) => ({
      evidenceId: `repo:${r.ownerLogin}/${r.name}`,
      sourcePlatform: 'github',
      sourceType: 'repo' as const,
      url: r.url,
      occurredAt: r.pushedAt ?? undefined,
      layer: 'L0' as const,
      claim: `仓库 ${r.name}`,
      rawRef: `${r.ownerLogin}/${r.name}`,
    })),
    ...commits.map(commitEvidence),
    ...pullRequests.map(prEvidence),
    ...issues.map(issueEvidence),
  ];

  return {
    subject: {
      login,
      displayName,
      avatarUrl: `https://avatars.example.com/${login}.png`,
      profileUrl: `https://github.com/${login}`,
      bio: 'Full-stack developer',
      company: 'Example Co',
      location: 'Shanghai',
      email,
      createdAt: seed.createdAt ?? '2018-03-14T00:00:00Z',
      followers: 320,
      following: 45,
      publicRepos: repos.length,
    },
    dataWindow: { since: '2018-03-14T00:00:00Z', until: '2026-08-20T00:00:00Z' },
    repos,
    commits,
    pullRequests,
    issues,
    contributions,
    evidence,
    missing: seed.missing ?? [],
    ...(seed.behaviorEvents ? { behaviorEvents: seed.behaviorEvents } : {}),
    collectedAt,
  };
}
