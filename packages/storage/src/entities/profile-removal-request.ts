/**
 * profile_removal_requests 实体：画像移除申请单（审计 S3「按主体撤回」，迁移 016）。
 *
 * 背景：`DELETE /profiles/:id` 只对已认领画像的本人开放，未认领画像的分享链
 * 没有自助撤销路径。请求者无法被服务端证明是本人，因此本表**只记录申请**，
 * 由运营在 CLI 复核后批准（级联删除）或驳回，从不自动执行。
 * 与方言无关的领域类型 + 纯映射逻辑（sqlite/postgres 两套仓储共享）。
 */

export type RemovalRequestStatus =
  | 'pending' // 已提交，等待复核；目标画像处于挂起态
  | 'approved' // 复核通过，画像已（或已在此之前被）删除
  | 'rejected'; // 复核驳回，挂起标记清除，画像恢复公开

export const REMOVAL_REQUEST_STATUSES: readonly RemovalRequestStatus[] = [
  'pending',
  'approved',
  'rejected',
];

/** 复核终态（decide 只接受这两种） */
export type RemovalDecision = Extract<RemovalRequestStatus, 'approved' | 'rejected'>;

export const REMOVAL_DECISIONS: readonly RemovalDecision[] = ['approved', 'rejected'];

export interface StoredProfileRemovalRequest {
  id: string;
  /** 目标画像 id（无外键；级联删除在业务层执行） */
  profileId: string;
  status: RemovalRequestStatus;
  /** 请求者填写的理由，可空 */
  reason: string | null;
  /** 请求者联系方式（供复核时联系），可空 */
  contact: string | null;
  /** 请求来源 IP 的加盐哈希（与 demo_rate_events 同口径），可空（取不到 IP 时） */
  ipHash: string | null;
  /** 提交时刻（UTC ISO8601） */
  createdAt: string;
  /** 复核时刻（UTC ISO8601）；pending 为 null */
  decidedAt: string | null;
}

export interface NewProfileRemovalRequest {
  /** 由调用方生成：`rem-<uuid>` */
  id: string;
  profileId: string;
  status?: RemovalRequestStatus;
  reason?: string | null;
  contact?: string | null;
  ipHash?: string | null;
  /** 提交时刻（UTC ISO8601），由调用方给出以保证与挂起标记同刻 */
  createdAt: string;
}

/** Drizzle 查询返回的原始行（camelCase），两方言结构一致 */
export interface RawProfileRemovalRequestRow {
  id: string;
  profileId: string;
  status: string;
  reason: string | null;
  contact: string | null;
  ipHash: string | null;
  createdAt: string;
  decidedAt: string | null;
}

export function toStoredProfileRemovalRequest(
  row: RawProfileRemovalRequestRow,
): StoredProfileRemovalRequest {
  const status = (REMOVAL_REQUEST_STATUSES as readonly string[]).includes(row.status)
    ? (row.status as RemovalRequestStatus)
    : 'pending';
  return {
    id: row.id,
    profileId: row.profileId,
    status,
    reason: row.reason ?? null,
    contact: row.contact ?? null,
    ipHash: row.ipHash ?? null,
    createdAt: row.createdAt,
    decidedAt: row.decidedAt ?? null,
  };
}
