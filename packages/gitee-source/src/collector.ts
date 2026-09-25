/**
 * GiteeSource：L0（账号 + 仓库）+ L1（最近提交 / 本人发起的 PR / Issue）采集，
 * 产出 analyzer-core 可直接消费的 AnalyzerInput 与 EvidenceItem。
 * 任一层失败只记 missing 并继续，账号不存在直接抛 not_found。
 */

import type { AnalyzerCommit, AnalyzerInput, AnalyzerIssue, AnalyzerPullRequest, BehaviorEventSummary } from '@jobagent/analyzer-core';
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
  summarizeGiteeEvents,
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

  /**
   * L1：最近提交 / PR / Issue / events 行为流（T25 L0 早返回拆分）。
   * 任一层失败只记 missing 并继续；budget_exhausted 上抛（由调用方决定降级或重试）。
   */
  async collectL1(
    login: string,
    subject: AnalyzerInput['subject'],
    repos: AnalyzerInput['repos'],
  ): Promise<{
    commits: AnalyzerCommit[];
    pullRequests: AnalyzerPullRequest[];
    issues: AnalyzerIssue[];
    behaviorEvents?: BehaviorEventSummary;
    missing: string[];
    eventsFetched: number;
    eventCommitsAdded: number;
  }> {
    const missing: string[] = [];
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
    // 方案 B-1：同一批 events 聚合为行为流摘要（跨仓广度/事件类型分布），供内核多样性信号
    const behaviorEvents = summarizeGiteeEvents(events, login);
    // 按 repo:oid 去重合并、采样优先，merge 内部按时间升序
    const allCommits = mergeSampledAndEventCommits(commits, eventCommits);
    const eventCommitsAdded = allCommits.length - commits.length;

    // Gitee PR 恒无增删行，只要采到 PR 就显式标注该维度缺失（设计 4.4）
    if (pullRequests.length > 0) missing.push('pr_code_stats');

    return {
      commits: allCommits,
      pullRequests,
      issues,
      ...(behaviorEvents ? { behaviorEvents } : {}),
      missing,
      eventsFetched: events.length,
      eventCommitsAdded,
    };
  }

  /** 完整采集：L0 + L1 → AnalyzerInput + 证据 + 元信息 */
  async collect(login: string): Promise<GiteeCollectedData> {
    const { subject, repos } = await this.collectL0(login);
    const l1 = await this.collectL1(login, subject, repos);
    const missing = [...l1.missing];

    const dataWindow = buildDataWindow(subject.createdAt, repos, l1.commits);
    const evidence: EvidenceItem[] = [
      buildGiteeSubjectEvidence(subject, dataWindow),
      ...repos.map(buildGiteeRepoEvidence),
      ...l1.pullRequests.map(buildGiteePullRequestEvidence),
      ...l1.issues.map(buildGiteeIssueEvidence),
      ...l1.commits.map(buildGiteeCommitEvidence),
    ];

    const input: AnalyzerInput = {
      subject,
      dataWindow,
      repos,
      commits: l1.commits,
      pullRequests: l1.pullRequests,
      issues: l1.issues,
      contributions: buildContributions(l1.commits, l1.pullRequests, l1.issues, repos),
      ...(l1.behaviorEvents ? { behaviorEvents: l1.behaviorEvents } : {}),
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
        eventsFetched: l1.eventsFetched,
        eventCommitsAdded: l1.eventCommitsAdded,
      },
    };
  }

  /**
   * 分阶段采集 L0（T25 L0 早返回）：只采账号元数据 + 仓库列表（Gitee L0 无行为时序），
   * 产出 L0 轻输入（commits/prs/issues 为空、missing=['l1_pending']）。返回 opaque
   * handle 给 collectStagedL1 复用（避免重复查询）。
   */
  async collectStagedL0(login: string): Promise<{
    handle: {
      subject: AnalyzerInput['subject'];
      repos: AnalyzerInput['repos'];
      l0Evidence: EvidenceItem[];
    };
    l0Input: AnalyzerInput;
    l0Evidence: EvidenceItem[];
    budgetUsed: { restCalls: number };
  }> {
    const { subject, repos } = await this.collectL0(login);
    const l0Window = buildDataWindow(subject.createdAt, repos, []);
    const l0Evidence: EvidenceItem[] = [
      buildGiteeSubjectEvidence(subject, l0Window),
      ...repos.map(buildGiteeRepoEvidence),
    ];
    const l0Input: AnalyzerInput = {
      subject,
      dataWindow: l0Window,
      repos,
      commits: [],
      pullRequests: [],
      issues: [],
      contributions: buildContributions([], [], [], repos),
      evidence: l0Evidence,
      missing: ['l1_pending'],
      collectedAt: new Date().toISOString(),
    };
    return { handle: { subject, repos, l0Evidence }, l0Input, l0Evidence, budgetUsed: { restCalls: this.client.restCalls } };
  }

  /**
   * 分阶段采集 L1（T25）：行为时序补齐 → 与 collect() 一致的完整输入。
   * L1 阶段任何失败（含 budget_exhausted）都不上抛——按 PRD F2 验收 3
   * "触发限频时优雅降级（先返回 L0，L1 异步补齐）"，降级返回仅 L0 输入。
   */
  async collectStagedL1(
    login: string,
    handle: {
      subject: AnalyzerInput['subject'];
      repos: AnalyzerInput['repos'];
      l0Evidence: EvidenceItem[];
    },
  ): Promise<{
    fullInput: AnalyzerInput;
    fullEvidence: EvidenceItem[];
    missing: string[];
    budgetUsed: { restCalls: number };
    l1Error?: string;
  }> {
    const { subject, repos, l0Evidence } = handle;
    try {
      const l1 = await this.collectL1(login, subject, repos);
      const dataWindow = buildDataWindow(subject.createdAt, repos, l1.commits);
      const fullEvidence: EvidenceItem[] = [
        buildGiteeSubjectEvidence(subject, dataWindow),
        ...repos.map(buildGiteeRepoEvidence),
        ...l1.pullRequests.map(buildGiteePullRequestEvidence),
        ...l1.issues.map(buildGiteeIssueEvidence),
        ...l1.commits.map(buildGiteeCommitEvidence),
      ];
      const fullInput: AnalyzerInput = {
        subject,
        dataWindow,
        repos,
        commits: l1.commits,
        pullRequests: l1.pullRequests,
        issues: l1.issues,
        contributions: buildContributions(l1.commits, l1.pullRequests, l1.issues, repos),
        ...(l1.behaviorEvents ? { behaviorEvents: l1.behaviorEvents } : {}),
        evidence: fullEvidence,
        missing: l1.missing,
        collectedAt: new Date().toISOString(),
      };
      return {
        fullInput,
        fullEvidence,
        missing: l1.missing,
        budgetUsed: { restCalls: this.client.restCalls },
      };
    } catch (err) {
      const message = (err as Error).message;
      this.log.warn(`[gitee-source] L1 stage failed for ${login}, keeping L0-only: ${message}`);
      return {
        fullInput: {
          subject,
          dataWindow: buildDataWindow(subject.createdAt, repos, []),
          repos,
          commits: [],
          pullRequests: [],
          issues: [],
          contributions: buildContributions([], [], [], repos),
          evidence: l0Evidence,
          missing: ['l1_failed'],
          collectedAt: new Date().toISOString(),
        },
        fullEvidence: l0Evidence,
        missing: ['l1_failed'],
        budgetUsed: { restCalls: this.client.restCalls },
        l1Error: message,
      };
    }
  }
}

export { GiteeSourceError } from './client.js';
