import type { AnalyzerInput, AnalyzerIssue, AnalyzerPullRequest, BehaviorEventSummary } from '@jobagent/analyzer-core';
import type { EvidenceItem } from '@jobagent/shared';
import type { Octokit } from 'octokit';
import { BudgetTracker } from './budget.js';
import { createOctokit, DEFAULT_BUDGET } from './client.js';
import {
  buildCommitEvidence,
  buildIssueEvidence,
  buildPullRequestEvidence,
  buildRepoEvidence,
  buildSubjectEvidence,
} from './evidence.js';
import {
  ISSUES_QUERY,
  L0_QUERY,
  PULL_REQUESTS_QUERY,
  REPO_COMMITS_QUERY,
  parseIssues,
  parseL0Response,
  parsePullRequests,
  parseRepoCommits,
  type IssuesResponse,
  type L0GraphqlResponse,
  type PullRequestsResponse,
  type RepoCommitsResponse,
} from './graphql.js';
import {
  fetchPublicEventsRest,
  fetchRepoCommitsCached,
  fetchUserEmailRest,
  HttpCache,
  summarizeGhEvents,
} from './rest.js';
import type { GitHubCollectedData, GitHubSourceOptions, L0Data, L1Data } from './types.js';

/** 采集错误：not_found（账号不存在）/ api_error（GitHub 侧失败）/ budget_exhausted */
export class GitHubSourceError extends Error {
  constructor(
    readonly code: 'not_found' | 'api_error' | 'budget_exhausted',
    message: string,
  ) {
    super(message);
    this.name = 'GitHubSourceError';
  }
}

export class GitHubSource {
  private readonly octokit: Octokit;
  private readonly budget: BudgetTracker;
  private readonly cache = new HttpCache();
  private readonly log: Pick<Console, 'info' | 'warn' | 'error'>;
  private readonly maxCommitsRepos = 10;
  private readonly commitsPerRepo = 30;

  constructor(options: GitHubSourceOptions) {
    this.log = options.log ?? console;
    this.budget = new BudgetTracker({ ...DEFAULT_BUDGET, ...(options.budget ?? {}) });
    this.octokit = createOctokit({
      token: options.token,
      budget: options.budget,
      log: this.log,
      fetch: options.fetch,
      throttleEnabled: options.throttleEnabled,
    });
  }

  /** GraphQL 统一入口：预算记账 + 错误归一 */
  private async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    if (this.budget.exhausted) {
      throw new GitHubSourceError('budget_exhausted', 'per-profile budget exhausted before request');
    }
    const res = await this.octokit.request('POST /graphql', { query, variables });
    // GitHub GraphQL 实测不返回 x-ratelimit-cost（2026-09-11）；按官方"单次查询 ≥1 点"保守记账
    const cost = Number(res.headers['x-ratelimit-cost']);
    this.budget.recordGraphql(Number.isFinite(cost) && cost > 0 ? cost : 1);
    const body = res.data as { data?: T; errors?: Array<{ message: string; type?: string }> };
    if (body.errors && body.errors.length > 0) {
      const first = body.errors[0];
      const message = first?.message ?? 'graphql error';
      // 账号/仓库不存在（含 login 实为 Organization 的情况）归一为 not_found
      const code = first?.type === 'NOT_FOUND' ? 'not_found' : 'api_error';
      throw new GitHubSourceError(code, message);
    }
    if (body.data === undefined) {
      throw new GitHubSourceError('api_error', 'graphql response missing data');
    }
    return body.data;
  }

  /** L0：账号元数据 + 仓库列表 + 贡献概览（一次批量查询） */
  async collectL0(login: string): Promise<{ l0: L0Data; evidence: EvidenceItem[] }> {
    const data = await this.graphql<L0GraphqlResponse>(L0_QUERY, { login });
    const l0 = parseL0Response(data, login);
    if (!l0) {
      throw new GitHubSourceError('not_found', `GitHub user "${login}" not found`);
    }
    const evidence: EvidenceItem[] = [
      buildSubjectEvidence(l0.subject, l0.dataWindow),
      ...l0.repos.map(buildRepoEvidence),
    ];
    return { l0, evidence };
  }

  /** L1：最近提交 + 发起的 PR/Issue（失败显式标注缺失，不中断整体） */
  async collectL1(login: string, l0: L0Data): Promise<{ l1: L1Data; evidence: EvidenceItem[]; missing: string[] }> {
    const missing: string[] = [];
    const l1: L1Data = { commits: [], pullRequests: [], issues: [] };
    const evidence: EvidenceItem[] = [];

    try {
      const prs = await this.graphql<PullRequestsResponse>(PULL_REQUESTS_QUERY, {
        login,
        first: 50,
      });
      l1.pullRequests = parsePullRequests(prs, login);
    } catch (err) {
      missing.push('pull_requests');
      this.log.warn(`[github-source] pull_requests failed for ${login}: ${(err as Error).message}`);
    }
    try {
      const issues = await this.graphql<IssuesResponse>(ISSUES_QUERY, { login, first: 30 });
      l1.issues = parseIssues(issues);
    } catch (err) {
      missing.push('issues');
      this.log.warn(`[github-source] issues failed for ${login}: ${(err as Error).message}`);
    }

    const activeRepos = l0.repos.filter((r) => !r.isArchived).slice(0, this.maxCommitsRepos);
    for (const repo of activeRepos) {
      if (this.budget.exhausted) {
        missing.push(`commits:${repo.name}`);
        this.log.warn('[github-source] budget exhausted, stopped fetching commits');
        break;
      }
      try {
        const data = await this.graphql<RepoCommitsResponse>(REPO_COMMITS_QUERY, {
          owner: repo.ownerLogin,
          name: repo.name,
          first: this.commitsPerRepo,
        });
        l1.commits.push(...parseRepoCommits(data, `${repo.ownerLogin}/${repo.name}`));
      } catch (err) {
        // GraphQL 失败回退 REST（带 ETag 条件请求）
        try {
          this.budget.recordRest();
          const { commits } = await fetchRepoCommitsCached(
            this.octokit,
            this.cache,
            repo.ownerLogin,
            repo.name,
            this.commitsPerRepo,
          );
          l1.commits.push(...commits);
        } catch (restErr) {
          missing.push(`commits:${repo.ownerLogin}/${repo.name}`);
          this.log.warn(
            `[github-source] commits failed for ${repo.ownerLogin}/${repo.name}: ${(restErr as Error).message}`,
          );
        }
      }
    }

    l1.commits.sort((a, b) => a.committedAt.localeCompare(b.committedAt));
    l1.pullRequests.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    l1.issues.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    evidence.push(
      ...l1.pullRequests.map(buildPullRequestEvidence),
      ...l1.issues.map(buildIssueEvidence),
      ...l1.commits.map((c) => buildCommitEvidence(c)),
    );
    return { l1, evidence, missing };
  }

  /** 完整采集：L0 + L1 → analyzer-core 输入 + 证据 + 元信息 */
  async collect(login: string): Promise<GitHubCollectedData> {
    const { l0, evidence: l0Evidence } = await this.collectL0(login);

    // REST 补充：公开 email（用于 author 一致性信号；失败不阻塞）
    let email: string | null = null;
    try {
      this.budget.recordRest();
      email = await fetchUserEmailRest(this.octokit, login);
    } catch {
      // 账号 email 非公开时保持 null
    }

    const { l1, evidence: l1Evidence, missing } = await this.collectL1(login, l0);

    // 方案 B-1：单次取 public events 第 1 页并聚合行为流摘要（REST +1；失败只记缺失，不阻塞）
    let behaviorEvents: BehaviorEventSummary | undefined;
    try {
      this.budget.recordRest();
      const eventRows = await fetchPublicEventsRest(this.octokit, login);
      behaviorEvents = summarizeGhEvents(eventRows, login) ?? undefined;
    } catch (err) {
      missing.push('events');
      this.log.warn(`[github-source] events failed for ${login}: ${(err as Error).message}`);
    }

    const input: AnalyzerInput = {
      subject: { ...l0.subject, email },
      dataWindow: l0.dataWindow,
      repos: l0.repos,
      commits: l1.commits,
      pullRequests: l1.pullRequests,
      issues: l1.issues,
      contributions: l0.contributions,
      ...(behaviorEvents ? { behaviorEvents } : {}),
      evidence: [...l0Evidence, ...l1Evidence],
      missing,
      collectedAt: new Date().toISOString(),
    };

    return {
      input,
      evidence: [...l0Evidence, ...l1Evidence],
      meta: {
        budgetUsed: this.budget.used,
        missing,
      },
    };
  }

  /**
   * 分阶段采集 L0（T28：仅用于降级，不用于提前发布）：只采账号元数据 + 仓库列表，
   * 产出 L0 轻输入（commits/prs/issues 为空、missing=['l1_pending']）——它只在 L1 失败时
   * 才会被 worker 作为"仅 L0"终态分析，正常路径等 L1 到齐后一次性发布。
   * 返回 opaque handle 给 collectStagedL1 复用（避免重复查询）。
   */
  async collectStagedL0(login: string): Promise<{
    handle: { l0: L0Data; email: string | null; l0Evidence: EvidenceItem[] };
    l0Input: AnalyzerInput;
    l0Evidence: EvidenceItem[];
    budgetUsed: { graphqlPoints: number; restCalls: number };
  }> {
    const { l0, evidence: l0Evidence } = await this.collectL0(login);

    // REST 补充 email（与 collect 一致；失败不阻塞，L0 轻画像的 subject 无 email 可接受）
    let email: string | null = null;
    try {
      this.budget.recordRest();
      email = await fetchUserEmailRest(this.octokit, login);
    } catch {
      // 账号 email 非公开时保持 null
    }

    const l0Input: AnalyzerInput = {
      subject: { ...l0.subject, email },
      dataWindow: l0.dataWindow,
      repos: l0.repos,
      commits: [],
      pullRequests: [],
      issues: [],
      contributions: l0.contributions,
      evidence: l0Evidence,
      missing: ['l1_pending'],
      collectedAt: new Date().toISOString(),
    };
    return { handle: { l0, email, l0Evidence }, l0Input, l0Evidence, budgetUsed: this.budget.used };
  }

  /**
   * 分阶段采集 L1（T25）：行为时序补齐 → 与 collect() 一致的完整输入。
   * L1 阶段任何失败（含 budget_exhausted）都不上抛——按 PRD F2 验收 3
   * "触发限频时优雅降级（先返回 L0，L1 异步补齐）"，降级返回仅 L0 输入。
   */
  async collectStagedL1(
    login: string,
    handle: { l0: L0Data; email: string | null; l0Evidence: EvidenceItem[] },
  ): Promise<{
    fullInput: AnalyzerInput;
    fullEvidence: EvidenceItem[];
    missing: string[];
    budgetUsed: { graphqlPoints: number; restCalls: number };
    l1Error?: string;
  }> {
    const { l0, email, l0Evidence } = handle;
    try {
      const { l1, evidence: l1Evidence, missing } = await this.collectL1(login, l0);
      let behaviorEvents: BehaviorEventSummary | undefined;
      try {
        this.budget.recordRest();
        const eventRows = await fetchPublicEventsRest(this.octokit, login);
        behaviorEvents = summarizeGhEvents(eventRows, login) ?? undefined;
      } catch (err) {
        missing.push('events');
        this.log.warn(`[github-source] events failed for ${login}: ${(err as Error).message}`);
      }
      const fullInput: AnalyzerInput = {
        subject: { ...l0.subject, email },
        dataWindow: l0.dataWindow,
        repos: l0.repos,
        commits: l1.commits,
        pullRequests: l1.pullRequests,
        issues: l1.issues,
        contributions: l0.contributions,
        ...(behaviorEvents ? { behaviorEvents } : {}),
        evidence: [...l0Evidence, ...l1Evidence],
        missing,
        collectedAt: new Date().toISOString(),
      };
      return {
        fullInput,
        fullEvidence: [...l0Evidence, ...l1Evidence],
        missing,
        budgetUsed: this.budget.used,
      };
    } catch (err) {
      const message = (err as Error).message;
      this.log.warn(`[github-source] L1 stage failed for ${login}, keeping L0-only: ${message}`);
      return {
        fullInput: {
          subject: { ...l0.subject, email },
          dataWindow: l0.dataWindow,
          repos: l0.repos,
          commits: [],
          pullRequests: [],
          issues: [],
          contributions: l0.contributions,
          evidence: l0Evidence,
          missing: ['l1_failed'],
          collectedAt: new Date().toISOString(),
        },
        fullEvidence: l0Evidence,
        missing: ['l1_failed'],
        budgetUsed: this.budget.used,
        l1Error: message,
      };
    }
  }
}
