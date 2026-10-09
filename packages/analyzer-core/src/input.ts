/**
 * analyzer-core 输入契约：证据源无关的结构化中间表示。
 * 契约本体已上移 @jobagent/shared（审计 A4：采集层不得反向依赖内核）；
 * 本文件保留为 re-export 兼容层，analyzer-core 内部与历史 import 路径不变。
 */

export type {
  AnalyzerCommit,
  AnalyzerInput,
  AnalyzerIssue,
  AnalyzerPullRequest,
  AnalyzerRepo,
  AnalyzerSubject,
  BehaviorEventSummary,
  ContributionMonth,
} from '@jobagent/shared';
export { repoRef } from '@jobagent/shared';
