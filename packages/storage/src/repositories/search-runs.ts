import type {
  NewSearchRun,
  SearchRunFinishPatch,
  StoredSearchRun,
} from '../entities/index.js';

/**
 * search_runs 仓储契约（迁移 032，设计 §3）。
 *
 * 业务模块只依赖此异步接口，不感知 SQLite/Postgres 方言。run 是登录用户的私有
 * 数据（accountId 作用域）；search-tick 通过 `claimNextQueued` 原子认领最老的
 * queued 行（防止两个 tick 同时处理同一 run），完成后用 `finish` 回写状态。
 */
export interface ISearchRunsRepository {
  insert(run: NewSearchRun): Promise<void>;
  getById(id: string): Promise<StoredSearchRun | undefined>;
  /** 列出某账号的搜岗任务，按 created_at 倒序，默认最多 20 条 */
  listByAccount(accountId: string, limit?: number): Promise<StoredSearchRun[]>;
  /**
   * 认领最老的 queued 行并置 running（单事务：先 UPDATE 匹配 WHERE status='queued'
   * 再 SELECT，天然互斥；无可用行返回 undefined）。返回的是已认领的行。
   */
  claimNextQueued(now: string): Promise<StoredSearchRun | undefined>;
  /**
   * 完成/失败回写（status + 统计 + error）；目标不存在或状态已非 running 时返回
   * undefined（调用方按幂等处理，不报错）。
   */
  finish(id: string, patch: SearchRunFinishPatch, updatedAt: string): Promise<StoredSearchRun | undefined>;
}
