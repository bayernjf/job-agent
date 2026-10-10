import type { NewJobRunEvent, StoredJobRunEvent } from '../entities/index.js';

/**
 * job_run_events 仓储契约（求职 Agent 阶段 1，迁移 020）。
 *
 * 只追加、不回改、不删除：这是可回放的迁移审计流，任何"更新/删除事件"的入口都不得
 * 从这里暴露出去。业务模块只依赖此异步接口，不感知 SQLite/Postgres 方言。
 */
export interface IJobRunEventsRepository {
  /** 追加一条迁移事件；payload 缺省落 '{}' */
  insert(event: NewJobRunEvent): Promise<void>;
  /**
   * 取某个 run 的**最新** `limit` 条事件（默认 200），返回仍按 created_at 升序（回放顺序）。
   * 截掉的是最旧的一批，不是最新的一批——自迁移事件（watching --rescan--> watching）每
   * tick 落一条，asc + limit 会让审计流在上限跑满后冻住，界面从此看不到新事件。
   *
   * `created_at` 相同时（同一次 tick 落多条迁移）按**写入顺序**排：SQLite 用 rowid、
   * Postgres 用 ctid。主键 `evt-<uuid>` 的字典序与时间无关，绝不能拿来当次级排序键。
   */
  listByRun(runId: string, limit?: number): Promise<StoredJobRunEvent[]>;
}
