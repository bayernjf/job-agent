import {
  OUTCOME_FEEDBACK_VALUES,
  type OutcomeFeedback,
} from '@jobagent/shared';

export type { OutcomeFeedback } from '@jobagent/shared';

/**
 * applications 实体：求职者画像侧的投递记录（痛点解决方案批次 2，2026-09-16）。
 *
 * 与方言无关的领域类型 + 纯映射逻辑（sqlite/postgres 两套仓储共享）。
 * 投递记录以 profile_id 关联到画像快照，由报告页/扩展写入；013 起另记
 * created_by_account_id（登录创建者），用于行级归属校验（决策 #17-F11）。
 * 企业侧反馈（查看/面试/offer）在账号体系落地前不开放，仅保留状态枚举位。
 */

/** 求职者侧投递漏斗状态 */
export type ApplicationStatus =
  | 'saved' // 已收藏 / 待投递
  | 'applied' // 已投递
  | 'viewed' // 简历被查看 / 初筛
  | 'interview' // 面试中
  | 'offer' // 拿到 offer
  | 'rejected' // 未通过
  | 'withdrawn'; // 候选人主动撤回

export const APPLICATION_STATUSES: readonly ApplicationStatus[] = [
  'saved',
  'applied',
  'viewed',
  'interview',
  'offer',
  'rejected',
  'withdrawn',
];

/** B3-b（迁移 039）：招聘方 pipeline 阶段（design-b3b-pipeline-state-machine）。 */
export type ApplicationStage =
  | 'new' // 新进入 pipeline
  | 'screening' // 初筛中
  | 'interview' // 面试中
  | 'offer' // 已发 offer
  | 'hired' // 已录用（终态）
  | 'rejected'; // 未通过（终态）

export const APPLICATION_STAGES: readonly ApplicationStage[] = [
  'new',
  'screening',
  'interview',
  'offer',
  'hired',
  'rejected',
];

/**
 * B3-b 合法迁移集。null 表示首次推进（招聘方直接落到当前位置，任意阶段均可）；
 * 非 null 时仅允许表中迁移。单向、不回退；hired/rejected 为终态。
 */
export const APPLICATION_STAGE_TRANSITIONS: Readonly<
  Record<ApplicationStage, readonly ApplicationStage[]>
> = {
  new: ['screening', 'rejected'],
  screening: ['interview', 'rejected'],
  interview: ['offer', 'rejected'],
  offer: ['hired', 'rejected'],
  hired: [],
  rejected: [],
};

/** B3-b 阶段迁移合法判定：fromStage=null（首次推进）任意 to 均合法。 */
export function isAllowedStageTransition(
  fromStage: ApplicationStage | null,
  toStage: ApplicationStage,
): boolean {
  if (fromStage === null) return true;
  return APPLICATION_STAGE_TRANSITIONS[fromStage].includes(toStage);
}

/** 投递动作来源 */
export type ApplicationOrigin = 'manual' | 'report' | 'extension' | 'agent';

export const APPLICATION_ORIGINS: readonly ApplicationOrigin[] = [
  'manual',
  'report',
  'extension',
  'agent',
];

export interface StoredApplication {
  id: string;
  profileId: string;
  /** 内部 job_postings.id；外部岗位或手动录入时为 null */
  jobId: string | null;
  /** 岗位来源 key（remoteok|greenhouse|...），可空 */
  source: string | null;
  targetTitle: string;
  targetCompany: string;
  targetUrl: string | null;
  status: ApplicationStatus;
  note: string | null;
  origin: ApplicationOrigin;
  /** 投递/记录时间（ISO8601），由调用方给出 */
  appliedAt: string;
  /**
   * 创建者账号（accounts.id）。013 之前写入的行、以及未登录时写入的行一律为 null，
   * 且**不回改**——当时的身份无法反推。null 行是否可改见仓储 update 的 scope 语义。
   */
  createdByAccountId: string | null;
  /**
   * 产出本行的投递票据（submit_intents.id，迁移 022）。手动/报告/扩展写入、以及
   * 022 之前的历史行一律为 null。
   */
  submitIntentId: string | null;
  /**
   * 阶段 2 D1：招聘方结果回写（no_response/interview/offer/rejected），
   * null=尚未回写。仅记录样本；D2 权重微调需 ≥20 条且人工确认（决策 #20-3）。
   */
  outcomeFeedback: OutcomeFeedback | null;
  /** 结果回写时间（UTC ISO8601），未回写为 null */
  outcomeFeedbackAt: string | null;
  /**
   * B3-b（迁移 039）：招聘方 pipeline 阶段；null=不在任何招聘方 pipeline
   * （历史行、手动投递、聚合岗位投递）。由岗位归属招聘方推进（PATCH /applications/:id/stage）。
   */
  stage: ApplicationStage | null;
  createdAt: string;
  updatedAt: string;
}

export interface NewApplication {
  id: string;
  profileId: string;
  jobId?: string | null;
  source?: string | null;
  targetTitle: string;
  targetCompany: string;
  targetUrl?: string | null;
  status?: ApplicationStatus;
  note?: string | null;
  origin?: ApplicationOrigin;
  appliedAt: string;
  /** 登录创建者；匿名写入传 null（缺省即 null） */
  createdByAccountId?: string | null;
  /** 022：产出本行的投递票据；非 Agent 流程写入传 null（缺省即 null） */
  submitIntentId?: string | null;
}

/** 可局部更新的字段（状态、备注、投递时间、岗位链接） */
export interface ApplicationPatch {
  status?: ApplicationStatus;
  note?: string | null;
  appliedAt?: string;
  targetUrl?: string | null;
  /** D1：结果回写（显式传 null 不清除；清除走专门流程，此处不开放） */
  outcomeFeedback?: OutcomeFeedback;
  outcomeFeedbackAt?: string;
}

/** Drizzle 查询返回的原始行（camelCase），两方言结构一致 */
export interface RawApplicationRow {
  id: string;
  profileId: string;
  jobId: string | null;
  source: string | null;
  targetTitle: string;
  targetCompany: string;
  targetUrl: string | null;
  status: string;
  note: string | null;
  origin: string;
  appliedAt: string;
  createdByAccountId: string | null;
  submitIntentId: string | null;
  outcomeFeedback: string | null;
  outcomeFeedbackAt: string | null;
  stage: string | null;
  createdAt: string;
  updatedAt: string;
}

export function toStoredApplication(row: RawApplicationRow): StoredApplication {
  const status = (APPLICATION_STATUSES as readonly string[]).includes(row.status)
    ? (row.status as ApplicationStatus)
    : 'applied';
  const origin = (APPLICATION_ORIGINS as readonly string[]).includes(row.origin)
    ? (row.origin as ApplicationOrigin)
    : 'manual';
  return {
    id: row.id,
    profileId: row.profileId,
    jobId: row.jobId,
    source: row.source,
    targetTitle: row.targetTitle,
    targetCompany: row.targetCompany,
    targetUrl: row.targetUrl,
    status,
    note: row.note,
    origin,
    appliedAt: row.appliedAt,
    createdByAccountId: row.createdByAccountId,
    submitIntentId: row.submitIntentId ?? null,
    outcomeFeedback: (OUTCOME_FEEDBACK_VALUES as readonly string[]).includes(
      row.outcomeFeedback ?? '',
    )
      ? (row.outcomeFeedback as OutcomeFeedback)
      : null,
    outcomeFeedbackAt: row.outcomeFeedbackAt ?? null,
    stage: (APPLICATION_STAGES as readonly string[]).includes(row.stage ?? '')
      ? (row.stage as ApplicationStage)
      : null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** 阶段迁移事件 actor（对齐 job_run_events 的 user|agent|system，招聘方侧用 recruiter） */
export type ApplicationEventActor = 'user' | 'recruiter' | 'system';

/** B3-b：写入 application_events 的一条阶段迁移（只追加，不回改） */
export interface NewApplicationEvent {
  id: string;
  applicationId: string;
  /** 本期唯一 kind：stage_change；预留扩展（如归属变更、手动修正） */
  event: string;
  /** 迁移前阶段；首次推进为 null */
  fromStage: ApplicationStage | null;
  toStage: ApplicationStage;
  actor: ApplicationEventActor;
  /** 结构化载荷（{ note?, postingId? }），缺省 '{}' */
  payload?: Record<string, unknown>;
  createdAt: string;
}

/** application_events 行（camelCase），两方言结构一致 */
export interface RawApplicationEventRow {
  id: string;
  applicationId: string;
  event: string;
  fromStage: string | null;
  toStage: string;
  actor: string;
  payload: string;
  createdAt: string;
}

export interface StoredApplicationEvent {
  id: string;
  applicationId: string;
  event: string;
  fromStage: ApplicationStage | null;
  toStage: ApplicationStage;
  actor: ApplicationEventActor;
  payload: Record<string, unknown>;
  createdAt: string;
}

export function toStoredApplicationEvent(row: RawApplicationEventRow): StoredApplicationEvent {
  let payload: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(row.payload);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      payload = parsed as Record<string, unknown>;
    }
  } catch {
    // 非法 JSON 保持 {}（对齐 job_run_events 的宽松读取）；只追加流不回改
  }
  return {
    id: row.id,
    applicationId: row.applicationId,
    event: row.event,
    fromStage: (APPLICATION_STAGES as readonly string[]).includes(row.fromStage ?? '')
      ? (row.fromStage as ApplicationStage)
      : null,
    toStage: (APPLICATION_STAGES as readonly string[]).includes(row.toStage)
      ? (row.toStage as ApplicationStage)
      : 'new',
    actor: (row.actor === 'user' || row.actor === 'recruiter' || row.actor === 'system'
      ? row.actor
      : 'system') as ApplicationEventActor,
    payload,
    createdAt: row.createdAt,
  };
}
