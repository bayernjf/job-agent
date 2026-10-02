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
  /** 取某个 run 的事件流，按 created_at 升序（回放顺序），默认最多 200 条 */
  listByRun(runId: string, limit?: number): Promise<StoredJobRunEvent[]>;
}
