/**
 * GiteeSource：L0（账号 + 仓库）+ L1（最近提交 / 本人发起的 PR / Issue）采集，
 * 产出 analyzer-core 可直接消费的 AnalyzerInput 与 EvidenceItem。
 * 任一层失败只记 missing 并继续，账号不存在直接抛 not_found。
 */

import type { AnalyzerCommit, AnalyzerInput, AnalyzerIssue, AnalyzerPullRequest } from '@jobagent/analyzer-core';
import type { EvidenceItem } from '@jobagent/shared';
import { GiteeClient, GiteeSourceError } from './client.js';
import {
  buildContributions,
  buildDataWindow,
  mapCommits,
  mapEventsToCommits,
  mapIssues,
  mapPullRequests,
  mapRepos,
  mapSubject,
  mergeSampledAndEventCommits,
} from './mappers.js';
import {
  buildGiteeCommitEvidence,
  buildGiteeIssueEvidence,
  buildGiteePullRequestEvidence,
  buildGiteeRepoEvidence,
  buildGiteeSubjectEvidence,
} from './evidence.js';
import type {
  GiteeCollectedData,
  GiteeCommitRaw,
  GiteeEventRaw,
  GiteeIssueRaw,
  GiteePullRaw,
  GiteeRepoRaw,
  GiteeSourceOptions,
  GiteeUserRaw,
} from './types.js';

const DEFAULT_BUDGET_REST_CALLS = 56;
const DEFAULT_MAX_COMMIT_REPOS = 8;
const DEFAULT_COMMITS_PER_REPO = 30;
const DEFAULT_REPO_PER_PAGE = 100;
const DEFAULT_MAX_REPO_PAGES = 3;
const PR_PER_PAGE = 50;
const ISSUE_PER_PAGE = 30;

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class GiteeSource {
  private readonly client: GiteeClient;
  private readonly log: Pick<Console, 'info' | 'warn' | 'error'>;
  private readonly maxCommitRepos: number;
  private readonly commitsPerRepo: number;
  private readonly repoPerPage: number;
  private readonly maxRepoPages: number;

  constructor(options: GiteeSourceOptions = {}) {
    this.log = options.log ?? console;
    this.maxCommitRepos = options.maxCommitRepos ?? DEFAULT_MAX_COMMIT_REPOS;
    this.commitsPerRepo = options.commitsPerRepo ?? DEFAULT_COMMITS_PER_REPO;
    this.repoPerPage = options.repoPerPage ?? DEFAULT_REPO_PER_PAGE;
    this.maxRepoPages = options.maxRepoPages ?? DEFAULT_MAX_REPO_PAGES;
    this.client = new GiteeClient({
      token: options.token,
      fetchImpl: options.fetch ?? globalThis.fetch,
      sleep: options.sleep ?? defaultSleep,
      budgetLimit: options.budget?.restCalls ?? DEFAULT_BUDGET_REST_CALLS,
      log: this.log,
    });
  }

  /** L0：账号元数据 + 仓库列表（账号 404 由 client 归一为 not_found） */
  async collectL0(login: string): Promise<{
    subject: AnalyzerInput['subject'];
    repos: AnalyzerInput['repos'];
  }> {
    const user = await this.client.get<GiteeUserRaw>(`/users/${encodeURIComponent(login)}`);
    const repoRows = await this.client.listAll<GiteeRepoRaw>(
      `/users/${encodeURIComponent(login)}/repos`,
      { perPage: this.repoPerPage, maxPages: this.maxRepoPages, params: { sort: 'pushed' } },
    );
    return {
      subject: mapSubject(user, login),
      repos: mapRepos(repoRows, login),
    };
  }

  /** 完整采集：L0 + L1 → AnalyzerInput + 证据 + 元信息 */
  async collect(login: string): Promise<GiteeCollectedData> {
    const missing: string[] = [];
    const { subject, repos } = await this.collectL0(login);

    const commits: AnalyzerCommit[] = [];
    const pullRequests: AnalyzerPullRequest[] = [];
    const issues: AnalyzerIssue[] = [];

    const activeRepos = repos.filter((r) => !r.isArchived).slice(0, this.maxCommitRepos);
    for (const repo of activeRepos) {
      const ref = `${repo.ownerLogin}/${repo.name}`;

      try {
        const rows = await this.client.listAll<GiteeCommitRaw>(
          `/repos/${encodeURIComponent(repo.ownerLogin)}/${encodeURIComponent(repo.name)}/commits`,
          { perPage: this.commitsPerRepo, maxPages: 1 },
        );
        commits.push(...mapCommits(rows, ref));
      } catch (err) {
        if ((err as GiteeSourceError).code === 'budget_exhausted') throw err;
        missing.push(`commits:${ref}`);
        this.log.warn(`[gitee-source] commits failed for ${ref}: ${(err as Error).message}`);
      }

      try {
        const rows = await this.client.listAll<GiteePullRaw>(
          `/repos/${encodeURIComponent(repo.ownerLogin)}/${encodeURIComponent(repo.name)}/pulls`,
          { perPage: PR_PER_PAGE, maxPages: 1, params: { state: 'all' } },
        );
        pullRequests.push(...mapPullRequests(rows, login, ref));
      } catch (err) {
        if ((err as GiteeSourceError).code === 'budget_exhausted') throw err;
        missing.push(`pull_requests:${ref}`);
        this.log.warn(`[gitee-source] pulls failed for ${ref}: ${(err as Error).message}`);
      }

      try {
        const rows = await this.client.listAll<GiteeIssueRaw>(
          `/repos/${encodeURIComponent(repo.ownerLogin)}/${encodeURIComponent(repo.name)}/issues`,
          { perPage: ISSUE_PER_PAGE, maxPages: 1, params: { state: 'all' } },
        );
        issues.push(...mapIssues(rows, login, ref));
      } catch (err) {
        if ((err as GiteeSourceError).code === 'budget_exhausted') throw err;
        missing.push(`issues:${ref}`);
        this.log.warn(`[gitee-source] issues failed for ${ref}: ${(err as Error).message}`);
      }
    }

    pullRequests.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    issues.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    // events/public 行为流（设计 §4.11）：只取一次——page/per_page 均被 Gitee 忽略、
    // 深翻会原样重复第 1 页，故严禁 listAll。用 PushEvent 补采样未覆盖的近期提交；
    // 端点失败只记 missing，不影响 L0/L1（budget_exhausted 仍上抛）。
    let events: GiteeEventRaw[] = [];
    try {
      const rows = await this.client.get<GiteeEventRaw[]>(
        `/users/${encodeURIComponent(login)}/events/public`,
        { page: 1, per_page: 20 },
      );
      events = Array.isArray(rows) ? rows : [];
    } catch (err) {
      if ((err as GiteeSourceError).code === 'budget_exhausted') throw err;
      missing.push('events');
      this.log.warn(`[gitee-source] events failed for ${login}: ${(err as Error).message}`);
    }
    const eventCommits = mapEventsToCommits(events, login);
    // 按 repo:oid 去重合并、采样优先，merge 内部按时间升序
    const allCommits = mergeSampledAndEventCommits(commits, eventCommits);
    const eventCommitsAdded = allCommits.length - commits.length;

    // Gitee PR 恒无增删行，只要采到 PR 就显式标注该维度缺失（设计 4.4）
    if (pullRequests.length > 0) missing.push('pr_code_stats');

    const dataWindow = buildDataWindow(subject.createdAt, repos, allCommits);
    const evidence: EvidenceItem[] = [
      buildGiteeSubjectEvidence(subject, dataWindow),
      ...repos.map(buildGiteeRepoEvidence),
      ...pullRequests.map(buildGiteePullRequestEvidence),
      ...issues.map(buildGiteeIssueEvidence),
      ...allCommits.map(buildGiteeCommitEvidence),
    ];

    const input: AnalyzerInput = {
      subject,
      dataWindow,
      repos,
      commits: allCommits,
      pullRequests,
      issues,
      contributions: buildContributions(allCommits, pullRequests, issues, repos),
      evidence,
      missing,
      collectedAt: new Date().toISOString(),
    };

    return {
      input,
      evidence,
      meta: {
        budgetUsed: { restCalls: this.client.restCalls },
        missing,
        eventsFetched: events.length,
        eventCommitsAdded,
      },
    };
  }
}

export { GiteeSourceError } from './client.js';
