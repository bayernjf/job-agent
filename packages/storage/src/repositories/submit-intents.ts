import type {
  JobSource,
  NewApplication,
  StoredApplication,
  NewSubmitIntent,
  StoredSubmitIntent,
  SubmitIntentStatus,
} from '../entities/index.js';

/**
 * 「标记已投 + 写投递记录」一体化原子操作的结果（mark-submitted 端点专用）：
 * - submitted：本事务完成票据 CAS（pending/approved → submitted）并插入了 application；
 * - already：票据已是 submitted（重复/并发标记），返回既有票据与其 application（可能查不到）；
 * - invalid：票据不存在或处于 rejected/withdrawn/failed 等不可复活状态（调用方回 409/404）。
 */
export type MarkSubmittedWithApplicationResult =
  | { outcome: 'submitted'; intent: StoredSubmitIntent; application: StoredApplication }
  | { outcome: 'already'; intent: StoredSubmitIntent; application: StoredApplication | undefined }
  | { outcome: 'invalid' };

/**
 * 「限频闸 + 批量确认」一体化原子操作的结果（approve 端点专用）：
 * - approved：事务内重新核对后整批置 approved，approved 为真正移动的行数（可能为 0，
 *   即候选在本事务执行前已被并发处理完）；
 * - quota_exceeded：某来源 24h 已确认/已投 + 本次待确认超过 dailyLimit，整事务回滚、
 *   绝不部分确认，返回超限来源与计数供调用方拼 429。
 */
export type ApproveManyWithQuotaResult =
  | { outcome: 'approved'; approved: number }
  | {
      outcome: 'quota_exceeded';
      source: JobSource;
      committed: number;
      remaining: number;
      requested: number;
    };

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
   * 触达通道（决策 #25）：跨 run 列出某账号 `created_at >= since` 的票据，digest-tick
   * 聚合"距上次 digest 后新增的待确认候选"用。按 created_at 升序。
   */
  listByAccountSince(accountId: string, since: string, limit?: number): Promise<StoredSubmitIntent[]>;
  /**
   * 批量确认：只改**该 run 内、当前为 'pending'** 的指定票据，返回真正被移动的行数。
   * 计数即"这次确认了几张票"，调用方据此判断是否有票据已被人抢先处理。
   */
  approveMany(runId: string, ids: readonly string[], approvedAt: string): Promise<number>;
  /**
   * 「24h 每源限频闸 + 批量确认」一体化原子操作（approve 端点专用，决策 §3.4 F1）：
   * 在**同一事务**内 ① 重新核对本次真正能移动的 pending 票据（该 run 内、id 命中、
   * 当前仍为 pending）并按来源分组；② 对每个来源叠加 `countCommittedBySourceSince`
   * 的 24h 已确认/已投计数；③ 任一来源超限则整事务回滚、返回 quota_exceeded，
   * **绝不部分确认**；④ 全部通过才执行条件 UPDATE，返回真正移动的行数。
   * `ids` 中已非 pending（被并发处理）的票据自动剔除，因此 requested 可能小于入参数。
   */
  approveManyWithQuota(
    runId: string,
    accountId: string,
    ids: readonly string[],
    dailyLimit: number,
    since: string,
    approvedAt: string,
  ): Promise<ApproveManyWithQuotaResult>;
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
   * 「标记已投 + 写投递记录」一体化原子操作（mark-submitted 端点专用，迁移 035）：
   * 在**同一事务**内先做票据 CAS（pending/approved → submitted），成功后才插入 application，
   * 因此 CAS 失败绝不会留下孤儿投递记录；application 与票据靠 submit_intent_id 部分唯一索引
   * （035）绑定，并发重复标记在唯一约束上撞车时按 `already` 幂等返回，不抛 500、不产生重复行。
   * 三结果判别见 {@link MarkSubmittedWithApplicationResult}。
   */
  markSubmittedWithApplication(
    intentId: string,
    application: NewApplication,
    submittedAt: string,
  ): Promise<MarkSubmittedWithApplicationResult>;
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
