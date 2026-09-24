/**
 * interviews 实体：招聘方侧的面试计划（handoff item45，2026-09-24）。
 *
 * 与方言无关的领域类型 + 纯映射逻辑（sqlite/postgres 两套仓储共享）。
 * 个人效率工具：每行以 created_by_account_id 归属到创建它的登录账号，
 * API 层做行级隔离；面试可直接挂在候选人画像上（applicationId 可空），
 * 也可关联一条求职者投递记录。枚举契约（format/status/outcome）的单一
 * 事实源在 @jobagent/shared，这里只复用、不重复定义。
 */
import {
  INTERVIEW_FORMATS,
  INTERVIEW_OUTCOMES,
  INTERVIEW_STATUSES,
  type InterviewFormat,
  type InterviewOutcome,
  type InterviewStatus,
} from '@jobagent/shared';

export type { InterviewFormat, InterviewOutcome, InterviewStatus };
export { INTERVIEW_FORMATS, INTERVIEW_OUTCOMES, INTERVIEW_STATUSES };

export interface StoredInterview {
  id: string;
  /** 候选人画像快照 id（主 scope） */
  profileId: string;
  /** 关联的 applications.id；直接从画像创建时为 null */
  applicationId: string | null;
  /** 面试岗位名称（冗余，无 application 也可读） */
  targetTitle: string;
  targetCompany: string | null;
  scheduledStart: string;
  scheduledEnd: string;
  format: InterviewFormat;
  /** 自由文本轮次，如 初筛 / 技术面 / 终面 */
  roundLabel: string;
  interviewerName: string | null;
  interviewerEmail: string | null;
  status: InterviewStatus;
  outcome: InterviewOutcome | null;
  feedbackNote: string | null;
  /** 1..5，未评分时为 null */
  rating: number | null;
  /** 行级归属：创建该面试的 accounts.id */
  createdByAccountId: string;
  createdAt: string;
  updatedAt: string;
}

export interface NewInterview {
  id: string;
  profileId: string;
  applicationId?: string | null;
  targetTitle: string;
  targetCompany?: string | null;
  scheduledStart: string;
  scheduledEnd: string;
  format: InterviewFormat;
  roundLabel: string;
  interviewerName?: string | null;
  interviewerEmail?: string | null;
  status?: InterviewStatus;
  outcome?: InterviewOutcome | null;
  feedbackNote?: string | null;
  rating?: number | null;
  createdByAccountId: string;
}

/** Drizzle 查询返回的原始行（camelCase），两方言结构一致 */
export interface RawInterviewRow {
  id: string;
  profileId: string;
  applicationId: string | null;
  targetTitle: string;
  targetCompany: string | null;
  scheduledStart: string;
  scheduledEnd: string;
  format: string;
  roundLabel: string;
  interviewerName: string | null;
  interviewerEmail: string | null;
  status: string;
  outcome: string | null;
  feedbackNote: string | null;
  rating: number | null;
  createdByAccountId: string;
  createdAt: string;
  updatedAt: string;
}

export function toStoredInterview(row: RawInterviewRow): StoredInterview {
  // 非法枚举值兜底：format/status 有合理默认；outcome 可空，非法值视为未填写
  const format = (INTERVIEW_FORMATS as readonly string[]).includes(row.format)
    ? (row.format as InterviewFormat)
    : 'onsite';
  const status = (INTERVIEW_STATUSES as readonly string[]).includes(row.status)
    ? (row.status as InterviewStatus)
    : 'scheduled';
  const outcome =
    row.outcome && (INTERVIEW_OUTCOMES as readonly string[]).includes(row.outcome)
      ? (row.outcome as InterviewOutcome)
      : null;
  return {
    id: row.id,
    profileId: row.profileId,
    applicationId: row.applicationId,
    targetTitle: row.targetTitle,
    targetCompany: row.targetCompany,
    scheduledStart: row.scheduledStart,
    scheduledEnd: row.scheduledEnd,
    format,
    roundLabel: row.roundLabel,
    interviewerName: row.interviewerName,
    interviewerEmail: row.interviewerEmail,
    status,
    outcome,
    feedbackNote: row.feedbackNote,
    rating: row.rating,
    createdByAccountId: row.createdByAccountId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
