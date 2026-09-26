/**
 * 画像装配：把各计算模块（真实性/标签/活动/面试题/摘要）组装为完整 AbilityProfile。
 * 纯函数、无 I/O；analyzerVersion = `${SCHEMA_VERSION}-${RULE_VERSION}` 保证可复现。
 */

import {
  SCHEMA_VERSION,
  composePrSummary,
  type AbilityProfile,
  type FusionReport,
  type SupportedPlatform,
} from '@jobagent/shared';
import type { AnalyzerInput } from './input.js';
import { computeActivity } from './activity.js';
import { generateInterviewQuestions } from './questions.js';
import { RULE_VERSION } from './rules.js';
import { computeAuthenticity } from './signals.js';
import { computeSkillTags } from './skills.js';
import { computeSummary } from './summary.js';
import { computeImprovementSuggestions } from './suggestions.js';

export interface AnalyzeOptions {
  /** 画像 ID（由调用方生成，如 CLI/Worker 的 uuid），保证 analyze 本身确定性 */
  profileId: string;
  /** 是否经本人 OAuth 认领（MVP CLI 为 false） */
  claimed?: boolean;
  /** 证据源平台；默认 'github'（第二个源 gitee 由 gitee-source 传入） */
  platform?: SupportedPlatform;
  /**
   * 跨源融合报告（仅 platform=all 双源成功融合时由调用方透传）。
   * 内核不解读融合，只把它原样挂到画像快照随快照持久化；单源分析缺省。
   */
  fusion?: FusionReport;
  /**
   * 已分析层覆盖（T25 L0 早返回）：默认 ['L0','L1']；仅传 L0 数据的轻画像
   * 传 ['L0']，避免快照宣称"L1 已分析"而实际没有行为数据。
   */
  layers?: Array<'L0' | 'L1'>;
}

export function assembleProfile(input: AnalyzerInput, options: AnalyzeOptions): AbilityProfile {
  const platform = options.platform ?? 'github';
  const { status, confidence, signals } = computeAuthenticity(input);
  const activity = computeActivity(input, signals);
  const skillTags = computeSkillTags(input);
  const summary = computeSummary(input, activity, { platform, skillTags });
  const interviewQuestions = generateInterviewQuestions(input);
  const improvementSuggestions = computeImprovementSuggestions(input);

  const mergedExternal = input.pullRequests.filter(
    (p) => !p.repoOwnerIsSelf && p.state === 'MERGED',
  );
  const mergedCount = input.pullRequests.filter((p) => p.state === 'MERGED').length;
  const known = new Set(input.evidence.map((e) => e.evidenceId));
  const collaboration: AbilityProfile['collaboration'] = {
    prSummary:
      input.pullRequests.length > 0
        ? composePrSummary(
            {
              opened: input.pullRequests.length,
              merged: mergedCount,
              externalMerged: mergedExternal.length,
            },
            'en',
          )
        : undefined,
    externalMergedContributions:
      mergedExternal.length > 0
        ? [...new Set(mergedExternal.map((p) => p.repoNameWithOwner))].slice(0, 5)
        : undefined,
    evidenceRefs: input.pullRequests
      .filter((p) => p.state === 'MERGED')
      .slice(0, 10)
      .map((p) => `pr:${p.repoNameWithOwner}:${p.number}`)
      .filter((r) => known.has(r)),
  };

  const platformLabel = platform === 'gitee' ? 'Gitee' : 'GitHub';
  const caveats = [
    'Analysis covers L0 metadata and L1 behavior sequences only; repository code content is not read (L2+ deferred).',
    'Commit authorship is inferred from author metadata and is not cryptographically verified.',
    `Public ${platformLabel} data only; activity on private repositories is not included.`,
  ];
  if (platform === 'gitee') {
    // Gitee 无 contributionCalendar，贡献计数由采样窗口聚合，口径与 GitHub 全年值不同
    caveats.push(
      'Contribution totals are aggregated from the sampled L1 window rather than a full-year contribution calendar.',
    );
  }
  if (input.missing.length > 0) {
    caveats.push(`Partial data missing during collection: ${input.missing.join(', ')}.`);
  }

  return {
    profileId: options.profileId,
    analyzerVersion: `${SCHEMA_VERSION}-${RULE_VERSION}`,
    generatedAt: input.collectedAt,
    dataWindow: input.dataWindow,
    analysisLayers: options.layers ?? ['L0', 'L1'],
    subject: {
      platform,
      login: input.subject.login,
      displayName: input.subject.displayName ?? undefined,
      avatarUrl: input.subject.avatarUrl ?? undefined,
      profileUrl: input.subject.profileUrl,
      claimed: options.claimed ?? false,
    },
    summary,
    skillTags,
    activity,
    collaboration,
    authenticity: { status, confidence, signals },
    interviewQuestions,
    ...(improvementSuggestions ? { improvementSuggestions } : {}),
    caveats,
    // 跨源融合报告仅由调用方在双源融合时透传，原样落快照；单源画像无此节
    ...(options.fusion ? { fusion: options.fusion } : {}),
  };
}
