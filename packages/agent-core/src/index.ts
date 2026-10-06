/**
 * 求职 Agent 内核（阶段 1「求职工作台」）。
 *
 * 硬约束（对齐 AGENTS「内核与 I/O 分离」）：本包纯函数、零 I/O、零 storage/网络依赖，
 * 输入是采集好的画像/岗位数据，输出是状态迁移、候选选择与可解释报告，可对固定夹具做单测。
 * 真正的编排（读库、写票据、跑 matchJobs、渲染简历）留在 apps/api 的 runner 与存储层。
 */

export { AGENT_RULE_VERSION, DEFAULT_CANDIDATE_LIMIT, DEFAULT_DAILY_SUBMIT_LIMIT, DEFAULT_MAX_GAPS } from './rules.js';

export {
  JOB_RUN_TRANSITIONS,
  TERMINAL_JOB_RUN_STATUSES,
  canCancel,
  isScannableStatus,
  isTerminalStatus,
  planTransition,
  type JobRunTransitionActor,
  type JobRunTransitionTable,
  type TransitionResult,
} from './state-machine.js';

export {
  TIER_ORDER,
  filterPostingsForPreference,
  isPreferredCompany,
  knownSources,
  normalizeText,
  passesQualityGate,
  preferenceSkills,
  preferenceToMatchCriteria,
  type MatchCriteriaLike,
  type PreferencePostingLike,
} from './preferences.js';

export {
  MATCH_FIELD_POINTS,
  buildMatchReport,
  matchGaps,
  matchReasons,
  passesTitleOrTagGuard,
  selectCandidates,
  selectCandidatesForPreference,
  type BuildMatchReportInput,
  type CandidateLike,
  type MatchFieldLike,
  type MatchLike,
  type SelectCandidatesOptions,
} from './match-report.js';

export {
  planIntents,
  toSubmitIntentJob,
  type IntentJobSnapshotSource,
  type PlannedIntent,
} from './plan.js';

export { remainingDailyQuota, submitLimitReached } from './limits.js';
export { hasUnseenApprovals, type UnseenRunFacts } from './unseen.js';
