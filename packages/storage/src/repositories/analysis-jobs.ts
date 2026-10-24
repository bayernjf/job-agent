import type { RequesterKind } from '@jobagent/shared';
import type {
  JobStage,
  JobStatus,
  NewAnalysisJob,
  StoredAnalysisJob,
} from '../entities/index.js';

/**
 * 重试预算的默认上限（＝最多认领 3 次）。
 *
 * 单一事实源：两方言仓储的 claimNext / reclaimStaleRunning 都以此为默认值，调用方
 * （worker 的 `MAX_RETRIES`）可以覆盖。此前 `3` 在两方言的 claimNext 里各写死一次，
 * 与 worker 的 `maxRetries` 是两个互不知情的数——把 worker 的旋钮调到 >3 会被静默截断。
 */
export const DEFAULT_JOB_MAX_ATTEMPTS = 3;

/**
 * analysis_jobs 仓储契约（异步任务队列），业务模块只依赖此接口。
 * claimNext 为原子认领：queued -> running，attempts+1；正式（非 demo）优先、同级 FIFO。
 */
export interface IAnalysisJobsRepository {
  create(job: NewAnalysisJob): Promise<void>;
  getById(id: string): Promise<StoredAnalysisJob | undefined>;
  /**
   * 认领至多一个 queued 任务。`maxAttempts` 是重试预算上限（默认
   * `DEFAULT_JOB_MAX_ATTEMPTS`）：`attempts >= maxAttempts` 的行不再被认领，
   * 调用方必须与 `reclaimStaleRunning` / worker 的失败判定用同一个数，否则会出现
   * 「既不可认领、又不是终态」的悬挂任务。
   */
  claimNext(workerId: string, maxAttempts?: number): Promise<StoredAnalysisJob | null>;
  /** 统计当前 running 且属于某请求者身份类的任务数（Worker demo 并发闸用） */
  countRunningByRequesterKind(kind: RequesterKind | 'public'): Promise<number>;
  updateStage(id: string, stage: JobStage): Promise<void>;
  succeed(
    id: string,
    profileId: string,
    budgetUsed?: Record<string, number>,
    missing?: string[],
  ): Promise<void>;
  fail(id: string, errorMessage: string): Promise<void>;
  resetToQueued(id: string, lastError: string): Promise<void>;
  /**
   * 非失败性退回：Worker demo 并发闸把已认领但暂不处理的任务放回 queued。
   * 与 resetToQueued 的区别：抵消本次 claimNext 的 attempts+1（下限 0）、不写 errorMessage，
   * 因此反复 defer 不会耗尽重试预算而让任务永久停领。
   */
  deferToQueued(id: string, note: string): Promise<void>;
  listBySubject(
    subjectPlatform: string,
    subjectLogin: string,
    limit?: number,
  ): Promise<StoredAnalysisJob[]>;
  latestActiveBySubject(
    subjectPlatform: string,
    subjectLogin: string,
  ): Promise<StoredAnalysisJob | undefined>;
  listQueued(limit?: number): Promise<StoredAnalysisJob[]>;
  countByStatus(): Promise<Record<JobStatus, number>>;
  /**
   * Reclaim jobs stuck in `running` for longer than maxAgeMs (worker crashed mid-job).
   *
   * A reclaimed job whose retry budget is already exhausted (`attempts >= maxAttempts`)
   * is moved to the terminal `failed` state instead of `queued`: requeueing it would
   * leave a row that `claimNext` filters out forever, so the job would never be picked
   * up again and never reach a terminal state — `latestActiveBySubject` would keep
   * reporting it as active and the client's poll would never resolve.
   *
   * Also self-heals any `queued` row already sitting at `attempts >= maxAttempts`
   * (the state the pre-fix reclaim could produce), so an existing backlog drains
   * without a data migration.
   *
   * Returns the total number of rows moved out of their stuck state (requeued + failed).
   */
  reclaimStaleRunning(maxAgeMs: number, maxAttempts?: number): Promise<number>;
}
