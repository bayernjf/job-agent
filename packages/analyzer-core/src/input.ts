/**
 * analyzer-core 输入契约：证据源无关的结构化中间表示。
 * github-source 产出它；未来 Gitee / 作品集适配器以同形状产出；内核不感知 I/O。
 */

import type { EvidenceItem } from '@jobagent/shared';

export interface AnalyzerSubject {
  login: string;
  displayName: string | null;
  avatarUrl: string | null;
  profileUrl: string;
  bio: string | null;
  company: string | null;
  location: string | null;
  email: string | null;
  createdAt: string | null;
  followers: number;
  following: number;
  publicRepos: number;
}

export interface AnalyzerRepo {
  /** 仓库短名（不含 owner） */
  name: string;
  /** 真实 owner login（可能是组织而非被分析用户本人，如 vitest-dev/vitest） */
  ownerLogin: string;
  url: string;
  isFork: boolean;
  isArchived: boolean;
  primaryLanguage: string | null;
  topics: string[];
  description: string | null;
  stargazerCount: number;
  forkCount: number;
  /** 空仓库从未推送时为 null */
  pushedAt: string | null;
  createdAt: string;
}

/** 仓库的全局唯一名 owner/name，用作证据 id 与跨表关联键（避免短名碰撞） */
export function repoRef(repo: AnalyzerRepo): string {
  return `${repo.ownerLogin}/${repo.name}`;
}

export interface AnalyzerCommit {
  oid: string;
  committedAt: string;
  authorName: string | null;
  authorEmail: string | null;
  /** 归属仓库的 owner/name（与 repoRef 一致） */
  repoName: string;
  messageHeadline: string;
}

export interface AnalyzerPullRequest {
  number: number;
  title: string;
  url: string;
  state: 'OPEN' | 'MERGED' | 'CLOSED';
  createdAt: string;
  mergedAt: string | null;
  repoNameWithOwner: string;
  repoIsFork: boolean;
  repoOwnerIsSelf: boolean;
  additions: number;
  deletions: number;
  changedFiles: number;
}

export interface AnalyzerIssue {
  number: number;
  title: string;
  url: string;
  state: 'OPEN' | 'CLOSED';
  createdAt: string;
  repoNameWithOwner: string;
}

export interface ContributionMonth {
  year: number;
  month: number;
  count: number;
}

/**
 * 行为流聚合摘要（方案 B，2026-09-15；设计 docs/design-behavior-diversity-20260915.md）。
 * 由各证据源从 public events 单次采集后聚合，是源无关的"事实计数"；
 * 哪些事件类型算协作型由 analyzer 内核判定（规则版本化），source 不做分析。
 * 可选：历史快照 / 端点失败 / 旧数据可能缺失，缺失时行为多样性信号走结构化降级。
 */
export interface BehaviorEventSummary {
  /** 采集到的事件条数（GitHub 取第 1 页 ≤100；Gitee 固定最近 20） */
  totalEvents: number;
  /** 事件涉及的不同 owner/name 仓库数（跨仓活动广度） */
  distinctRepoCount: number;
  /** 各事件类型 → 条数（行为多样性事实，如 {PushEvent:12,PullRequestEvent:3}） */
  eventTypeCounts: Record<string, number>;
  /** 最早事件时间（ISO，可空） */
  since?: string;
  /** 最晚事件时间（ISO，可空） */
  until?: string;
}

export interface AnalyzerInput {
  subject: AnalyzerSubject;
  dataWindow: { since: string; until: string };
  repos: AnalyzerRepo[];
  commits: AnalyzerCommit[];
  pullRequests: AnalyzerPullRequest[];
  issues: AnalyzerIssue[];
  contributions: {
    totalCommitContributions: number;
    totalPullRequestContributions: number;
    totalIssueContributions: number;
    totalRepositoryContributions: number;
    contributionMonths: ContributionMonth[];
  };
  /** 采集到的证据项：analyzer 只读，用于校验 evidenceRefs 真实存在（无证据不下结论） */
  /**
   * public events 行为流聚合（方案 B，可选）：用于跨仓广度 / 行为多样性信号；
   * 缺失时该信号只依据 commits/PR/issues 的结构化形态判定，绝不因缺字段判负。
   */
  behaviorEvents?: BehaviorEventSummary;
  evidence: EvidenceItem[];
  /** 显式缺失标注（如部分数据获取失败）；缺失数据不得被当作"没有" */
  missing: string[];
  collectedAt: string;
}
