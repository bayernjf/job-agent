/**
 * analyzer-core：纯函数分析内核（M1·W2）。
 * 输入采集后的结构化数据（AnalyzerInput），输出 AbilityProfile；
 * 无网络、无数据库、无文件 I/O，规则版本化，可在固定夹具上做确定性单测。
 */

import type { AbilityProfile } from '@jobagent/shared';
import type { AnalyzerInput } from './input.js';
import { assembleProfile, type AnalyzeOptions } from './profile.js';
import { RULE_VERSION } from './rules.js';

/** 单一入口：结构化数据 → 能力画像（纯函数，同输入同输出） */
export function analyze(input: AnalyzerInput, options: AnalyzeOptions): AbilityProfile {
  return assembleProfile(input, options);
}

export { RULE_VERSION } from './rules.js';
export { SIGNAL_CODES } from './rules.js';
export { computeAuthenticity, computeAuthenticitySignals } from './signals.js';
export { computeSkillTags } from './skills.js';
export { fuseInputs } from './fusion.js';
export type { FusionResult } from './fusion.js';
export type { FusionReport, MirrorPair, SuspectedMirror } from '@jobagent/shared';
export { computeActivity } from './activity.js';
export { generateInterviewQuestions } from './questions.js';
export { computeSummary } from './summary.js';
export type {
  AnalyzerCommit,
  AnalyzerInput,
  AnalyzerIssue,
  AnalyzerPullRequest,
  AnalyzerRepo,
  AnalyzerSubject,
  ContributionMonth,
  BehaviorEventSummary,
} from './input.js';
export type { AnalyzeOptions } from './profile.js';
export type { AbilityProfile };
