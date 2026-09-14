/**
 * gitee-source：Gitee 证据源（第二个 EvidenceSource，2026-09-14）。
 * REST-only（Gitee v5），产出与 github-source 同构的 AnalyzerInput + EvidenceItem。
 * 设计：docs/design-gitee-source-20260914.md。
 */

export { GiteeSource, GiteeSourceError } from './collector.js';
export { GiteeClient } from './client.js';
export {
  aggregateCommitMonths,
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
  toUtc,
} from './mappers.js';
export {
  buildGiteeCommitEvidence,
  buildGiteeIssueEvidence,
  buildGiteePullRequestEvidence,
  buildGiteeRepoEvidence,
  buildGiteeSubjectEvidence,
} from './evidence.js';
export type {
  GiteeBudget,
  GiteeCollectedData,
  GiteeCommitRaw,
  GiteeEventCommitRaw,
  GiteeEventRaw,
  GiteeIssueRaw,
  GiteePullRaw,
  GiteeRepoRaw,
  GiteeSourceOptions,
  GiteeUserRaw,
} from './types.js';
