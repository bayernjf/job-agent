import type {
  NewProfileRemovalRequest,
  RemovalDecision,
  RemovalRequestStatus,
  StoredProfileRemovalRequest,
} from '../entities/index.js';

/**
 * profile_removal_requests 仓储契约（审计 S3，迁移 016）。
 *
 * 业务模块只依赖此接口，不感知 SQLite/Postgres 方言。写入面刻意窄：只增申请单、
 * 只翻复核终态，**不提供删除**（审计流水不可抹）；挂起态由
 * `IProfilesRepository.setRemovalRequestedAt` 表达，两者由调用方保持同步。
 */
export interface IProfileRemovalRequestsRepository {
  insert(request: NewProfileRemovalRequest): Promise<void>;
  getById(id: string): Promise<StoredProfileRemovalRequest | undefined>;
  /**
   * 取该画像最新一条 pending 申请（幂等判断用）。一个画像最多只应有一条 pending；
   * 历史 rejected 之后再次申请会新建一条，故按 created_at 倒序取首条。
   */
  latestPendingByProfile(profileId: string): Promise<StoredProfileRemovalRequest | undefined>;
  /** 复核队列：按状态列出，默认最新在前 */
  listByStatus(
    status: RemovalRequestStatus,
    limit?: number,
  ): Promise<StoredProfileRemovalRequest[]>;
  /**
   * 复核结单：只接受终态 approved/rejected。已结单（decided_at 非空）的申请不再改写，
   * 返回当前行；不存在返回 undefined。
   */
  decide(
    id: string,
    status: RemovalDecision,
    decidedAt: string,
  ): Promise<StoredProfileRemovalRequest | undefined>;
}
