/**
 * 画像摘要：headline（数据层英文，报告页按结构化字段 i18n 双语渲染）与
 * seniorityHint（保守估计：年限 + 贡献量双门槛，置信度上限 0.6，证据不足则省略）。
 */

import type { AbilityProfile } from '@jobagent/shared';
import type { AnalyzerInput } from './input.js';

export function computeSummary(
  input: AnalyzerInput,
  activity: NonNullable<AbilityProfile['activity']>,
): AbilityProfile['summary'] {
  const topLang = input.repos[0]?.primaryLanguage ?? null;
  const repoCount = input.repos.length;
  const months = activity.longevityMonths;
  const known = new Set(input.evidence.map((e) => e.evidenceId));

  const headline = topLang
    ? `${input.subject.login} — ${topLang} developer with ${repoCount} public repo${repoCount === 1 ? '' : 's'}${
        months ? ` and ${months} months of GitHub activity` : ''
      }`
    : `${input.subject.login} — GitHub developer with ${repoCount} public repo${repoCount === 1 ? '' : 's'}${
        months ? ` and ${months} months of GitHub activity` : ''
      }`;

  const totalCommits = input.commits.length + input.contributions.totalCommitContributions;
  const refs = [`user:${input.subject.login}`].filter((r) => known.has(r));

  let seniorityHint: AbilityProfile['summary']['seniorityHint'];
  if (months !== undefined && months >= 36 && totalCommits >= 200) {
    seniorityHint = { band: 'senior', confidence: 0.6, evidenceRefs: refs };
  } else if (months !== undefined && months >= 12 && totalCommits >= 60) {
    seniorityHint = { band: 'mid', confidence: 0.55, evidenceRefs: refs };
  } else if (months !== undefined && months >= 6 && totalCommits >= 20) {
    seniorityHint = { band: 'junior', confidence: 0.5, evidenceRefs: refs };
  }

  return { headline, seniorityHint };
}
