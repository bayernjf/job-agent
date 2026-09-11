/**
 * github-source：GitHub 证据源（EvidenceSource 首个实现，M1·W2）。
 * Octokit + GraphQL 批量优先 / REST 补，L0 元数据 + L1 行为时序，
 * 单画像预算 / 限频退避 / ETag 缓存 / 显式缺失标注。
 */

export { BudgetTracker } from './budget.js';
export { createOctokit, DEFAULT_BUDGET } from './client.js';
export { GitHubSource, GitHubSourceError } from './collector.js';
export {
  aggregateContributionMonths,
  ISSUES_QUERY,
  L0_QUERY,
  parseIssues,
  parseL0Response,
  parsePullRequests,
  parseRepoCommits,
  PULL_REQUESTS_QUERY,
  REPO_COMMITS_QUERY,
} from './graphql.js';
export {
  buildCommitEvidence,
  buildIssueEvidence,
  buildPullRequestEvidence,
  buildRepoEvidence,
  buildSubjectEvidence,
} from './evidence.js';
export {
  fetchRepoCommitsCached,
  fetchRepoCommitsRest,
  fetchUserEmailRest,
  HttpCache,
  isNotModifiedError,
  parseRestCommits,
} from './rest.js';
export type { GitHubCollectedData, GitHubSourceOptions, L0Data, L1Data, ProfileBudget } from './types.js';
