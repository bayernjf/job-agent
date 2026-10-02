import type {
  JobRunStatus,
  JobRunStatusPatch,
  NewJobRun,
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
  /** 无条件推进状态（仅用于不需要并发保护的系统内部动作）；不存在返回 undefined */
  setStatus(id: string, patch: JobRunStatusPatch): Promise<StoredJobRun | undefined>;
  /**
   * 调度队列：按状态取最久没被扫描的 run（`last_scan_at` 升序、NULL 最前，
   * 同刻再按 created_at 升序），默认最多 20 条。NULL 最前保证"从未扫描过"的
   * 新 run 先被认领，而不是被已经扫过的行永久压在队尾。
   */
  listByStatuses(statuses: readonly JobRunStatus[], limit?: number): Promise<StoredJobRun[]>;
}
