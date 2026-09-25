/**
 * 活动画像：活跃跨度、节奏摘要、突发模式（复用真实性信号）、可复核计数。
 * 所有文本为数据层英文；报告页按结构化字段做 i18n 双语渲染（决策 #4）。
 */

import type { AbilityProfile, AuthenticitySignal } from '@jobagent/shared';
import type { AnalyzerInput } from './input.js';
import { SIGNAL_CODES } from './rules.js';

export function computeActivity(
  input: AnalyzerInput,
  signals: AuthenticitySignal[],
): NonNullable<AbilityProfile['activity']> {
  const dates = [
    ...input.commits.map((c) => c.committedAt),
    ...input.pullRequests.map((p) => p.createdAt),
    ...input.issues.map((i) => i.createdAt),
    ...input.repos.map((r) => r.pushedAt),
  ].filter((d): d is string => d != null && Number.isFinite(Date.parse(d)));

  const earliest = dates.length > 0 ? dates.reduce((a, b) => (a < b ? a : b)) : input.collectedAt;
  const latest = dates.length > 0 ? dates.reduce((a, b) => (a > b ? a : b)) : input.collectedAt;
  const months =
    dates.length > 0
      ? Math.max(1, Math.round((Date.parse(latest) - Date.parse(earliest)) / (30.44 * 86_400_000)))
      : 0;
  const longevityMonths = months;

  const cadenceSummary =
    input.commits.length > 0 && months > 0
      ? `${(input.commits.length / months).toFixed(1)} commits/month across ${months} active months`
      : undefined;

  const burstPattern = signals.find((s) => s.code === SIGNAL_CODES.COMMIT_BURST);

  // T06：合并 PR 的改动规模。只有提供 diff 统计的证据源参与；一个都没有时整个键
  // 缺席而不是写 0——"不知道"必须能被读成"不知道"，否则 Gitee-only 画像会被
  // 误读成"合并了 0 行代码"。
  const mergedDiffLines = input.pullRequests
    .filter((p) => p.state === 'MERGED')
    .map((p) => (p.additions !== null && p.deletions !== null ? p.additions + p.deletions : null))
    .filter((n): n is number => n !== null);

  const metrics: Record<string, number> = {
    totalCommits: input.commits.length,
    totalPullRequests: input.pullRequests.length,
    mergedPullRequests: input.pullRequests.filter((p) => p.state === 'MERGED').length,
    ...(mergedDiffLines.length > 0
      ? {
          mergedDiffLines: mergedDiffLines.reduce((a, b) => a + b, 0),
          largestMergedPrDiff: Math.max(...mergedDiffLines),
        }
      : {}),
    totalIssues: input.issues.length,
    totalRepos: input.repos.length,
    totalStars: input.repos.reduce((sum, r) => sum + r.stargazerCount, 0),
    totalForks: input.repos.reduce((sum, r) => sum + r.forkCount, 0),
    activeMonths: months,
    commitRepoCount: new Set(input.commits.map((c) => c.repoName)).size,
    ...(input.behaviorEvents
      ? {
          eventTotalEvents: input.behaviorEvents.totalEvents,
          eventDistinctRepos: input.behaviorEvents.distinctRepoCount,
          eventTypeKinds: Object.keys(input.behaviorEvents.eventTypeCounts).length,
        }
      : {}),
  };

  return {
    longevityMonths: longevityMonths > 0 ? longevityMonths : undefined,
    cadenceSummary,
    burstPattern,
    metrics,
  };
}
