/**
 * analysis_jobs 实体：异步分析任务队列的领域类型与纯映射（双方言共享）。
 * 状态机：queued -> running -> succeeded | failed。
 */
import type { RequesterKind } from '@jobagent/shared';

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed';
export type JobStage = 'L0' | 'L1' | 'complete';

export const JOB_STATUSES: readonly JobStatus[] = ['queued', 'running', 'succeeded', 'failed'];
export const JOB_STAGES: readonly JobStage[] = ['L0', 'L1', 'complete'];

export interface NewAnalysisJob {
  id: string;
  subjectPlatform?: string;
  subjectLogin: string;
  /** 请求者身份类（演示模式 008 迁移）；缺省 'public'，兼容既有调用 */
  requesterKind?: RequesterKind | 'public';
  /** requesterKind='demo' 时归属的演示会话 id，其余为 null/缺省 */
  demoSessionId?: string | null;
}

export interface StoredAnalysisJob {
  id: string;
  subjectPlatform: string;
  subjectLogin: string;
  status: JobStatus;
  stage: JobStage | null;
  attempts: number;
  profileId: string | null;
  errorMessage: string | null;
  budgetUsed: Record<string, number> | null;
  missing: string[] | null;
  claimedBy: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  requesterKind: RequesterKind | 'public';
  demoSessionId: string | null;
}

/** Drizzle 查询返回的原始行（camelCase），两方言结构一致 */
export interface RawAnalysisJobRow {
  id: string;
  subjectPlatform: string;
  subjectLogin: string;
  status: string;
  stage: string | null;
  attempts: number;
  profileId: string | null;
  errorMessage: string | null;
  budgetUsed: string | null;
  missing: string | null;
  claimedBy: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  requesterKind: string;
  demoSessionId: string | null;
}

export function parseJson<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function toStoredJob(row: RawAnalysisJobRow): StoredAnalysisJob {
  return {
    id: row.id,
    subjectPlatform: row.subjectPlatform,
    subjectLogin: row.subjectLogin,
    status: (JOB_STATUSES as readonly string[]).includes(row.status)
      ? (row.status as JobStatus)
      : 'failed',
    stage:
      row.stage && (JOB_STAGES as readonly string[]).includes(row.stage)
        ? (row.stage as JobStage)
        : null,
    attempts: row.attempts,
    profileId: row.profileId,
    errorMessage: row.errorMessage,
    budgetUsed: parseJson<Record<string, number>>(row.budgetUsed),
    missing: parseJson<string[]>(row.missing),
    claimedBy: row.claimedBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    requesterKind: (row.requesterKind as RequesterKind | 'public') ?? 'public',
    demoSessionId: row.demoSessionId ?? null,
  };
}
