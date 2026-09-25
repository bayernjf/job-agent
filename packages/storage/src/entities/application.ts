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

/** 投递动作来源 */
export type ApplicationOrigin = 'manual' | 'report' | 'extension';

export const APPLICATION_ORIGINS: readonly ApplicationOrigin[] = ['manual', 'report', 'extension'];

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
}

/** 可局部更新的字段（状态、备注、投递时间、岗位链接） */
export interface ApplicationPatch {
  status?: ApplicationStatus;
  note?: string | null;
  appliedAt?: string;
  targetUrl?: string | null;
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
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
