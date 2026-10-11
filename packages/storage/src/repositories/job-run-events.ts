import type { NewJobRunEvent, StoredJobRunEvent } from '../entities/index.js';

/**
 * job_run_events 仓储契约（求职 Agent 阶段 1，迁移 020）。
 *
 * 只追加、不回改、不删除：这是可回放的迁移审计流，任何"更新/删除事件"的入口都不得
 * 从这里暴露出去。业务模块只依赖此异步接口，不感知 SQLite/Postgres 方言。
 */
export interface JobRunEventPage {
  /** 正序（回放顺序）的一页事件 */
  events: StoredJobRunEvent[];
  /** 本页之外是否还有**更早**的事件（哨兵行探出来，不是猜的） */
  hasMore: boolean;
}

export interface IJobRunEventsRepository {
  /** 追加一条迁移事件；payload 缺省落 '{}' */
  insert(event: NewJobRunEvent): Promise<void>;
  /**
   * 取某个 run **最新**的一页事件（默认 200 条），返回按 created_at 升序（回放顺序）。
   * 截掉的是最旧的一批，不是最新的一批——自迁移事件（watching --rescan--> watching）每
   * tick 落一条，`asc + limit` 会让审计流在上限跑满后冻住，界面从此看不到新事件。
   */
  listLatestPage(runId: string, limit?: number): Promise<JobRunEventPage>;
  /**
   * 取 `beforeEventId` **之前（更早）**的一页，同样升序返回；游标是事件 id 而不是时间戳：
   * 同一次 tick 落的多条迁移共用同一个 created_at，时间戳游标会把它们从中间切断（丢事件）。
   * 游标 id 不存在或不属于该 run 时返回 undefined（调用方显式报错，不伪装成"到底了"）。
   *
   * 两个方法的排序都带写入序做次级键（SQLite `rowid` / Postgres `ctid`）：主键 `evt-<uuid>`
   * 的字典序与时间无关，拿它当次级键会把同刻的多条迁移排成乱序。
   */
  listOlderPage(
    runId: string,
    beforeEventId: string,
    limit?: number,
  ): Promise<JobRunEventPage | undefined>;
}
