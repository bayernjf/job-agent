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
 *
 * ⚠️ 成本硬约束（2026-10-09 决策）：搜岗是付费搜索（Tavily credits）。
 * **唯一创建 run 的入口 = 登录态 POST /api/agent/search（用户主动）**；
 * 定时调度只允许消费（claimNextQueued）既存任务，**禁止任何自动/定时创建路径**，
 * 否则账单会失控。新增创建入口前必须过设计评审。
 */
export interface ISearchRunsRepository {
  insert(run: NewSearchRun): Promise<void>;
  getById(id: string): Promise<StoredSearchRun | undefined>;
  /** 列出某账号的搜岗任务，按 created_at 倒序，默认最多 20 条 */
  listByAccount(accountId: string, limit?: number): Promise<StoredSearchRun[]>;
  /**
   * 统计某账号自 sinceIso 起创建的搜岗任务数（T2-9 每日配额护栏）。
   * 按创建计数（含失败 run），防刷目的优先；窗口由调用方按 UTC 日界计算。
   */
  countByAccountSince(accountId: string, sinceIso: string): Promise<number>;
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
  /**
   * 把 `running` 且 `updated_at` 早于 (now - maxAgeMs) 的滞留任务落终态 `failed`，
   * 返回处置条数。
   *
   * 与 analysis_jobs 的 reclaimStaleRunning 有一处**刻意的不同：这里绝不退回 queued**。
   * search_runs 没有 attempts 列，而每执行一个 run 都要真实花掉 Tavily credits——
   * 退回重试等于把同一笔已付费的搜索无限重放。落 failed 并写明原因；用户要重试
   * 就新建一次搜岗（唯一创建入口仍是登录态 POST /api/agent/search，见文件头的成本硬约束）。
   *
   * 需要它的原因：search-tick 在执行中被 serverless 平台切断（CF Worker 的 CPU/时长上限）
   * 时，run 会停在 `running`；而 `claimNextQueued` 只认 `status='queued'`，没有这一步
   * 它就永远卡住、前端轮询永不收敛，且钱已经花了。
   */
  reclaimStaleRunning(maxAgeMs: number, now: string): Promise<number>;
  /**
   * 删除单条搜岗历史（仅删个人视角的发起记录，不级联删共享岗位池）。
   * 归属校验由调用方用 getById 完成。
   */
  delete(id: string): Promise<boolean>;
  /** 清空某账号全部搜岗历史（同上，不删岗位池）。返回删除条数。 */
  deleteAllByAccount(accountId: string): Promise<number>;
}
