import type {
  JobStage,
  JobStatus,
  NewAnalysisJob,
  StoredAnalysisJob,
} from '../entities/index.js';

/**
 * analysis_jobs 仓储契约（异步任务队列），业务模块只依赖此接口。
 * claimNext 为原子认领：queued -> running，attempts+1，只认领最老一行。
 */
export interface IAnalysisJobsRepository {
  create(job: NewAnalysisJob): Promise<void>;
  getById(id: string): Promise<StoredAnalysisJob | undefined>;
  claimNext(workerId: string): Promise<StoredAnalysisJob | null>;
  updateStage(id: string, stage: JobStage): Promise<void>;
  succeed(
    id: string,
    profileId: string,
    budgetUsed?: Record<string, number>,
    missing?: string[],
  ): Promise<void>;
  fail(id: string, errorMessage: string): Promise<void>;
  resetToQueued(id: string, lastError: string): Promise<void>;
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
