import type {
  JobRunStatus,
  JobRunStatusPatch,
  NewJobRun,
  NewJobRunEvent,
  NewSubmitIntent,
  StoredJobRun,
} from '../entities/index.js';

/**
 * job_runs 仓储契约（求职 Agent 阶段 1，迁移 019）。
 *
 * 业务模块只依赖此异步接口，不感知 SQLite/Postgres 方言。本仓储是**并发闸**所在：
 * `compareAndSetStatus` 必须是单条条件 UPDATE（`where id = ? and status = ?expect`），
 * 这样 cron 调度与用户手动触发同时推进同一个 run 时，只有一个能成功——失败方拿到
 * undefined，据此放弃本轮而不是把两轮扫描的结果互相覆盖。
 */
export interface IJobRunsRepository {
  /** 插入一个 run；状态固定从 'created' 起步（推进只能走状态补丁） */
  insert(run: NewJobRun): Promise<void>;
  getById(id: string): Promise<StoredJobRun | undefined>;
  /** 列出某账号的 run，按 created_at 倒序，默认最多 50 条 */
  listByAccount(accountId: string, limit?: number): Promise<StoredJobRun[]>;
  /**
   * 原子比较并推进状态：仅当当前状态等于 `expectStatus` 时写入 patch。
   * 返回更新后的新行；当前状态不匹配（或 id 不存在）时返回 undefined——
   * 调用方不得把它当成"已完成"，必须放弃本轮。
   */
  compareAndSetStatus(
    id: string,
    expectStatus: JobRunStatus,
    patch: JobRunStatusPatch,
  ): Promise<StoredJobRun | undefined>;
  /**
   * 「CAS 推进 + 落审计事件」一体化原子操作（求职 Agent 硬约束②，agent-runner 的
   * applyRunEvent 专用）：同一事务内先做条件 UPDATE，影响 0 行（并发输家/状态已变）
   * → **不**插事件、返回 undefined；成功才在同一事务插入 job_run_events。
   * 杜绝「状态推进了但事件丢失」或「事件落了但 CAS 失败」的中间态——崩溃恢复后
   * 状态与可回放事件流永远一致。`event.runId` 必须等于 `id`（调用方按 planTransition 装配）。
   */
  compareAndSetStatusWithEvent(
    id: string,
    expectStatus: JobRunStatus,
    patch: JobRunStatusPatch,
    event: NewJobRunEvent,
  ): Promise<StoredJobRun | undefined>;
  /**
   * scanOnce 尾部专用三表原子操作（recommending → awaiting_approval 闸）：
   * 同一事务内 ① 条件 UPDATE job_runs（CAS 闸）；② CAS 成功才批量插入 submit_intents；
   * ③ 落 generated 事件。CAS 影响 0 行（并发输家/滞留已被回收）→ **零票据、零事件**、
   * 返回 undefined，绝不留下「recommending 已回到 watching、孤儿票据永不再生成」的行。
   * `event.runId` 必须等于 `runId`；`intents` 不允许为空（无候选时调用方走 rescan 分支）。
   */
  publishGeneratedIntents(
    runId: string,
    expectStatus: JobRunStatus,
    patch: JobRunStatusPatch,
    event: NewJobRunEvent,
    intents: readonly NewSubmitIntent[],
  ): Promise<StoredJobRun | undefined>;
  /** 无条件推进状态（仅用于不需要并发保护的系统内部动作）；不存在返回 undefined */
  setStatus(id: string, patch: JobRunStatusPatch): Promise<StoredJobRun | undefined>;
  /**
   * 记录拥有者查看：只写 last_viewed_at，**不**推进状态、**不**碰 updated_at
   * （查看不是状态迁移，也不能让调度队列因 updated_at 抖动而乱序）。
   * 返回更新后的行；id 不存在返回 undefined。
   */
  markViewed(id: string, viewedAt: string): Promise<StoredJobRun | undefined>;
  /**
   * 调度队列：按状态取最久没被扫描的 run（`last_scan_at` 升序、NULL 最前，
   * 同刻再按 created_at 升序），默认最多 20 条。NULL 最前保证"从未扫描过"的
   * 新 run 先被认领，而不是被已经扫过的行永久压在队尾。
   */
  listByStatuses(statuses: readonly JobRunStatus[], limit?: number): Promise<StoredJobRun[]>;
}
