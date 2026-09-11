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
  ].filter((d) => Number.isFinite(Date.parse(d)));

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

  const metrics: Record<string, number> = {
    totalCommits: input.commits.length,
    totalPullRequests: input.pullRequests.length,
    mergedPullRequests: input.pullRequests.filter((p) => p.state === 'MERGED').length,
    totalIssues: input.issues.length,
    totalRepos: input.repos.length,
    totalStars: input.repos.reduce((sum, r) => sum + r.stargazerCount, 0),
    totalForks: input.repos.reduce((sum, r) => sum + r.forkCount, 0),
    activeMonths: months,
  };

  return {
    longevityMonths: longevityMonths > 0 ? longevityMonths : undefined,
    cadenceSummary,
    burstPattern,
    metrics,
  };
}
