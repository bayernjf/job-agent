/**
 * 画像摘要：headline（数据层英文，文案模板与渲染侧共用 shared 的 composeHeadline）与
 * seniorityHint（保守估计：年限 + 贡献量双门槛，置信度上限 0.6，证据不足则省略）。
 */

import {
  composeHeadline,
  type AbilityProfile,
  type SkillTag,
  type SupportedPlatform,
} from '@jobagent/shared';
import type { AnalyzerInput } from './input.js';

export interface SummaryOptions {
  /** 画像主体平台；headline 按它取平台名，Gitee 主体不能写成 GitHub */
  platform: SupportedPlatform;
  /** 已算好的能力标签：主力语言取其中置信度最高的 language 标签 */
  skillTags: SkillTag[];
}

export function computeSummary(
  input: AnalyzerInput,
  activity: NonNullable<AbilityProfile['activity']>,
  options: SummaryOptions,
): AbilityProfile['summary'] {
  const repoCount = input.repos.length;
  const months = activity.longevityMonths;
  const known = new Set(input.evidence.map((e) => e.evidenceId));

  const headline = composeHeadline(
    {
      platform: options.platform,
      language: options.skillTags.find((tag) => tag.kind === 'language')?.name ?? null,
      repoCount,
      months,
    },
    'en',
  );

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
