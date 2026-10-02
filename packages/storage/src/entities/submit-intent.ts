/**
 * submit_intents 实体：人机闸投递票据（求职 Agent 阶段 1，迁移 021，设计 §4.3）。
 *
 * 一条 = 一个待投岗位。阶段 1 的硬边界是"Agent 只准备、人执行"：票据自带岗位精简快照
 * 与可解释匹配报告（只出 code + 事实），用户确认/拒绝/标记已投都由用户动作驱动；
 * 票据状态与来源的单一事实源在 `@jobagent/shared`。
 * 与方言无关的领域类型 + 纯映射逻辑（sqlite/postgres 两套仓储共享）。
 */
import {
  JobSourceSchema,
  MatchScoreTierSchema,
  SUBMIT_INTENT_STATUSES,
  type JobSource,
  type MatchReport,
  type MatchScoreTier,
  type SubmitIntentJob,
  type SubmitIntentStatus,
} from '@jobagent/shared';
import { parseJson } from './analysis-job.js';

// 类型与状态数组的单一事实源在 @jobagent/shared；本地只再导出，不重复定义。
export type {
  JobSource,
  MatchReport,
  MatchScoreTier,
  SubmitIntentJob,
  SubmitIntentStatus,
} from '@jobagent/shared';
export { SUBMIT_INTENT_STATUSES };

/** 票据状态全集（shared 为单一事实源；本名与契约一致） */
const SUBMIT_INTENT_STATUS_VALUES: readonly string[] = SUBMIT_INTENT_STATUSES;
/** 岗位来源取值（shared 为单一事实源） */
const JOB_SOURCE_VALUES: readonly string[] = JobSourceSchema.options;
/** 匹配分档取值（shared 为单一事实源） */
const MATCH_TIER_VALUES: readonly string[] = MatchScoreTierSchema.options;

export interface StoredSubmitIntent {
  id: string;
  /** 归属任务（job_runs.id） */
  runId: string;
  /** 归属账号（accounts.id） */
  accountId: string;
  /** 打分所用画像快照（profiles.id） */
  profileId: string;
  /** 岗位池 job_postings.id */
  jobId: string;
  /** 岗位来源；限频按来源统计，故独立成列 */
  jobSource: JobSource;
  /** 岗位精简快照（岗位池会被日更覆盖/下架，票据必须自证投的是哪一条） */
  job: SubmitIntentJob;
  /** matchJobs 加权总分 */
  matchScore: number;
  matchTier: MatchScoreTier;
  /** 可解释匹配报告（code + 事实，无散文） */
  report: MatchReport;
  status: SubmitIntentStatus;
  /** 用户拒绝原因；非拒绝态为 null */
  rejectReason: string | null;
  approvedAt: string | null;
  rejectedAt: string | null;
  submittedAt: string | null;
  /** 标记已投时写入的 applications.id */
  applicationId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 入库输入：id/归属/岗位/打分必填；状态与各时间戳缺省（'pending' + null） */
export interface NewSubmitIntent {
  /** 由调用方生成：`intent-<uuid>` */
  id: string;
  runId: string;
  accountId: string;
  profileId: string;
  jobId: string;
  jobSource: JobSource;
  job: SubmitIntentJob;
  matchScore: number;
  matchTier: MatchScoreTier;
  report: MatchReport;
  status?: SubmitIntentStatus;
  rejectReason?: string | null;
  approvedAt?: string | null;
  rejectedAt?: string | null;
  submittedAt?: string | null;
  applicationId?: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 可局部更新的字段（updatedAt 必填，由调用方给出以保持与事件同刻） */
export interface SubmitIntentPatch {
  status?: SubmitIntentStatus;
  rejectReason?: string | null;
  approvedAt?: string | null;
  rejectedAt?: string | null;
  submittedAt?: string | null;
  applicationId?: string | null;
  updatedAt: string;
}

/** Drizzle 查询返回的原始行（camelCase）；JSON 列与时间戳为 TEXT */
export interface RawSubmitIntentRow {
  id: string;
  runId: string;
  accountId: string;
  profileId: string;
  jobId: string;
  jobSource: string;
  jobSnapshot: string;
  matchScore: number;
  matchTier: string;
  matchReport: string;
  status: string;
  rejectReason: string | null;
  approvedAt: string | null;
  rejectedAt: string | null;
  submittedAt: string | null;
  applicationId: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * 快照解析失败时的退化岗位：字段一律取空值，绝不猜测标题/公司
 * （快照列 NOT NULL 且只由本层写入，走到这里意味着数据损坏，宁可显式空洞）。
 */
function degradedJob(row: RawSubmitIntentRow, source: JobSource): SubmitIntentJob {
  return {
    jobId: row.jobId,
    source,
    sourceUrl: '',
    title: '',
    company: '',
    location: null,
    remote: false,
    salaryMin: null,
    salaryMax: null,
    salaryCurrency: null,
    tags: [],
    postedAt: row.createdAt,
  };
}

/** 报告解析失败时的退化报告：保留库里的 score/tier 两列事实，其余清空（规则版本显式标 unknown，不冒充某个版本） */
function degradedReport(score: number, tier: MatchScoreTier): MatchReport {
  return {
    ruleVersion: 'unknown',
    score,
    tier,
    fieldScores: { title: 0, tags: 0, description: 0 },
    matchedSkills: [],
    reasons: [],
    gaps: [],
    suggestedBoost: [],
  };
}

/**
 * Drizzle 行 → 领域对象（纯函数，双方言共用）。
 * 未知取值回退到**不会绕过人机闸、也不会虚增质量**的一侧：来源回退 'manual'（非岗位池）、
 * 状态回退 'pending'（重新落回待投清单，绝不假装"已投/已确认"）、匹配档回退 'low'
 * （低于任何质量闸）。两个 JSON 列解析失败时退化为显式空洞，不编造事实。
 */
export function toStoredSubmitIntent(row: RawSubmitIntentRow): StoredSubmitIntent {
  const jobSource = JOB_SOURCE_VALUES.includes(row.jobSource)
    ? (row.jobSource as JobSource)
    : 'manual';
  const status = SUBMIT_INTENT_STATUS_VALUES.includes(row.status)
    ? (row.status as SubmitIntentStatus)
    : 'pending';
  const matchTier = MATCH_TIER_VALUES.includes(row.matchTier)
    ? (row.matchTier as MatchScoreTier)
    : 'low';
  return {
    id: row.id,
    runId: row.runId,
    accountId: row.accountId,
    profileId: row.profileId,
    jobId: row.jobId,
    jobSource,
    job: parseJson<SubmitIntentJob>(row.jobSnapshot) ?? degradedJob(row, jobSource),
    matchScore: row.matchScore,
    matchTier,
    report: parseJson<MatchReport>(row.matchReport) ?? degradedReport(row.matchScore, matchTier),
    status,
    rejectReason: row.rejectReason ?? null,
    approvedAt: row.approvedAt ?? null,
    rejectedAt: row.rejectedAt ?? null,
    submittedAt: row.submittedAt ?? null,
    applicationId: row.applicationId ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
