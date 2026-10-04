import type {
  JobSource,
  NewSubmitIntent,
  StoredSubmitIntent,
  SubmitIntentStatus,
} from '../entities/index.js';

/**
 * submit_intents 仓储契约（求职 Agent 阶段 1，迁移 021，设计 §4.3）。
 *
 * 业务模块只依赖此异步接口，不感知 SQLite/Postgres 方言。本仓储承担两件事：
 * 1. **人机闸的状态守卫**：approve/reject/markSubmitted 都只在自己允许的起始状态上生效
 *    （条件 UPDATE），不满足时返回 undefined，绝不静默改写已结单的票据；
 * 2. **每源每日限频的计数**：`countCommittedBySourceSince` 只统计已确认/已投出的票据。
 */
export interface ISubmitIntentsRepository {
  insert(intent: NewSubmitIntent): Promise<void>;
  /** 批量落票据（一轮扫描的候选清单）；空数组为 no-op */
  insertMany(intents: readonly NewSubmitIntent[]): Promise<void>;
  getById(id: string): Promise<StoredSubmitIntent | undefined>;
  /** 某个 run 的待投清单，按 created_at 倒序，默认最多 100 条 */
  listByRun(runId: string, limit?: number): Promise<StoredSubmitIntent[]>;
  /** 某个 run 中指定状态的票据，按 created_at 倒序，默认最多 100 条 */
  listByRunAndStatus(
    runId: string,
    status: SubmitIntentStatus,
    limit?: number,
  ): Promise<StoredSubmitIntent[]>;
  /**
   * 阶段 2 A2：跨 run 列出某账号所有 status='approved'（已确认待填充）的票据，
   * 供浏览器扩展在 ATS 页面按 URL 匹配后自动填充。按 approved_at 倒序。
   */
  listFillableByAccount(accountId: string, limit?: number): Promise<StoredSubmitIntent[]>;
  /**
   * 批量确认：只改**该 run 内、当前为 'pending'** 的指定票据，返回真正被移动的行数。
   * 计数即"这次确认了几张票"，调用方据此判断是否有票据已被人抢先处理。
   */
  approveMany(runId: string, ids: readonly string[], approvedAt: string): Promise<number>;
  /**
   * 拒绝一张票：仅当当前状态为 'pending'。guard 不满足或 id 不存在时返回 undefined。
   * `reason` 为 null 表示用户没填原因。
   */
  reject(
    id: string,
    reason: string | null,
    rejectedAt: string,
  ): Promise<StoredSubmitIntent | undefined>;
  /**
   * 标记已投：仅当当前状态为 'pending' 或 'approved'（已拒绝/已撤回的票不可复活）。
   * `applicationId` 为写入 applications 后回填的 id，可为 null。guard 不满足返回 undefined。
   */
  markSubmitted(
    id: string,
    submittedAt: string,
    applicationId: string | null,
  ): Promise<StoredSubmitIntent | undefined>;
  /**
   * 每源每日限频计数：统计该账号该来源下 `status IN ('approved','submitted')` 且
   * `submitted_at >= since` 或 `approved_at >= since` 的票据数。
   * 只算"已确认/已投出"，待投与已拒绝不计入，避免限频把用户自己的犹豫算成投递。
   */
  countCommittedBySourceSince(
    accountId: string,
    jobSource: JobSource,
    since: string,
  ): Promise<number>;
}
