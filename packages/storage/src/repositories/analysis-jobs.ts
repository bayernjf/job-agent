import type { RequesterKind } from '@jobagent/shared';
import type {
  JobStage,
  JobStatus,
  NewAnalysisJob,
  StoredAnalysisJob,
} from '../entities/index.js';

/**
 * analysis_jobs 仓储契约（异步任务队列），业务模块只依赖此接口。
 * claimNext 为原子认领：queued -> running，attempts+1；正式（非 demo）优先、同级 FIFO。
 */
export interface IAnalysisJobsRepository {
  create(job: NewAnalysisJob): Promise<void>;
  getById(id: string): Promise<StoredAnalysisJob | undefined>;
  claimNext(workerId: string): Promise<StoredAnalysisJob | null>;
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
  /** Reclaim running jobs older than maxAgeMs (worker crashed mid-job). Returns count requeued. */
  reclaimStaleRunning(maxAgeMs: number): Promise<number>;
}
