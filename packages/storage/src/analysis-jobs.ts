import { and, desc, eq, asc, isNull, lt, or, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { analysisJobs, type AnalysisJobSelect } from './schema.js';

/**
 * analysis_jobs 仓储——异步分析任务队列的唯一数据访问入口。
 *
 * MVP 用单 Worker 轮询/认领，不引入 Redis（技术选型 6.6）。
 * 认领操作为原子事务：queued -> running，attempts+1，记录 claimedBy/startedAt。
 * 状态机：queued -> running -> succeeded | failed。
 *
 * 所有 DB 访问收敛在此模块（AGENTS.md「数据访问抽象层」硬约束），
 * 业务模块禁止裸 SQL 或直接调用 Drizzle。
 */

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed';
export type JobStage = 'L0' | 'L1' | 'complete';

export const JOB_STATUSES: readonly JobStatus[] = ['queued', 'running', 'succeeded', 'failed'];
export const JOB_STAGES: readonly JobStage[] = ['L0', 'L1', 'complete'];

export interface NewAnalysisJob {
  id: string;
  subjectPlatform?: string;
  subjectLogin: string;
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
}

function parseJson<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function toStoredJob(row: AnalysisJobSelect): StoredAnalysisJob {
  return {
    id: row.id,
    subjectPlatform: row.subjectPlatform,
    subjectLogin: row.subjectLogin,
    status: (JOB_STATUSES as readonly string[]).includes(row.status)
      ? (row.status as JobStatus)
      : 'failed',
    stage: row.stage && (JOB_STAGES as readonly string[]).includes(row.stage)
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
  };
}

export class AnalysisJobsRepository {
  constructor(private readonly db: BetterSQLite3Database) {}

  /** 创建新任务（queued 状态） */
  create(job: NewAnalysisJob): void {
    this.db
      .insert(analysisJobs)
      .values({
        id: job.id,
        subjectPlatform: job.subjectPlatform ?? 'github',
        subjectLogin: job.subjectLogin,
        status: 'queued',
        attempts: 0,
      })
      .run();
  }

  /** 按 ID 查询 */
  getById(id: string): StoredAnalysisJob | undefined {
    const row = this.db.select().from(analysisJobs).where(eq(analysisJobs.id, id)).get();
    return row ? toStoredJob(row) : undefined;
  }

  /**
   * 原子认领下一个 queued 任务。
   * 事务内：UPDATE queued -> running（最老的一个），attempts+1，记录 claimedBy/startedAt，
   * 然后 SELECT 被更新的行返回。无 queued 任务时返回 null。
   */
  claimNext(workerId: string): StoredAnalysisJob | null {
    const now = new Date().toISOString();
    let claimedId: string | null = null;

    // SQLite 事务内读写原子（串行化隔离），两步法保证只认领最老的一行：
    // 1. SELECT 最老的 queued id；2. UPDATE 该特定 id（WHERE id + status 双重校验）
    this.db.transaction((tx) => {
      const oldest = tx
        .select({ id: analysisJobs.id })
        .from(analysisJobs)
        .where(
          and(
            eq(analysisJobs.status, 'queued'),
            lt(analysisJobs.attempts, 3), // 避免无限重试
          ),
        )
        .orderBy(asc(analysisJobs.createdAt))
        .limit(1)
        .get();

      if (!oldest) return;

      const updated = tx
        .update(analysisJobs)
        .set({
          status: 'running',
          stage: 'L0',
          attempts: sql`${analysisJobs.attempts} + 1`,
          claimedBy: workerId,
          startedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(analysisJobs.id, oldest.id),
            eq(analysisJobs.status, 'queued'), // 双重校验，防止并发认领
          ),
        )
        .returning({ id: analysisJobs.id })
        .all();

      if (updated.length > 0) {
        claimedId = updated[0]!.id;
      }
    });

    if (!claimedId) return null;
    return this.getById(claimedId) ?? null;
  }

  /** 更新进度阶段（L0 -> L1 -> complete） */
  updateStage(id: string, stage: JobStage): void {
    this.db
      .update(analysisJobs)
      .set({ stage, updatedAt: new Date().toISOString() })
      .where(eq(analysisJobs.id, id))
      .run();
  }

  /** 标记任务成功，关联 profileId，记录预算和缺失层 */
  succeed(
    id: string,
    profileId: string,
    budgetUsed?: Record<string, number>,
    missing?: string[],
  ): void {
    const now = new Date().toISOString();
    this.db
      .update(analysisJobs)
      .set({
        status: 'succeeded',
        stage: 'complete',
        profileId,
        budgetUsed: budgetUsed ? JSON.stringify(budgetUsed) : null,
        missing: missing ? JSON.stringify(missing) : null,
        finishedAt: now,
        updatedAt: now,
      })
      .where(eq(analysisJobs.id, id))
 .run();
  }

  /** 标记任务失败，记录错误信息 */
  fail(id: string, errorMessage: string): void {
    const now = new Date().toISOString();
    this.db
      .update(analysisJobs)
      .set({
        status: 'failed',
        errorMessage,
        finishedAt: now,
        updatedAt: now,
      })
      .where(eq(analysisJobs.id, id))
      .run();
  }

  /**
   * 重置任务为 queued 等待重试（attempts < maxRetries 时使用）。
   * 保留 attempts 计数（claimNext 时已 +1），记录最近一次错误信息，
   * 清空 stage/startedAt/finishedAt/claimedBy，下次认领时重新填充。
   */
  resetToQueued(id: string, lastError: string): void {
    const now = new Date().toISOString();
    this.db
      .update(analysisJobs)
      .set({
        status: 'queued',
        stage: null,
        errorMessage: lastError,
        claimedBy: null,
        startedAt: null,
        finishedAt: null,
        updatedAt: now,
      })
      .where(eq(analysisJobs.id, id))
      .run();
  }

  /** 按用户查询历史任务（按创建时间倒序） */
  listBySubject(
    subjectPlatform: string,
    subjectLogin: string,
    limit = 20,
  ): StoredAnalysisJob[] {
    const rows = this.db
      .select()
      .from(analysisJobs)
      .where(
        and(
          eq(analysisJobs.subjectPlatform, subjectPlatform),
          eq(analysisJobs.subjectLogin, subjectLogin),
        ),
      )
      .orderBy(desc(analysisJobs.createdAt))
      .limit(limit)
      .all();
    return rows.map(toStoredJob);
  }

  /** 查询用户最新的一个任务（用于去重：同一用户最近有 running/queued 任务则不新建） */
  latestActiveBySubject(
    subjectPlatform: string,
    subjectLogin: string,
  ): StoredAnalysisJob | undefined {
    const rows = this.db
      .select()
      .from(analysisJobs)
      .where(
        and(
          eq(analysisJobs.subjectPlatform, subjectPlatform),
          eq(analysisJobs.subjectLogin, subjectLogin),
          or(eq(analysisJobs.status, 'queued'), eq(analysisJobs.status, 'running')),
        ),
      )
      .orderBy(desc(analysisJobs.createdAt))
      .limit(1)
      .all();
    return rows.length > 0 ? toStoredJob(rows[0]!) : undefined;
  }

  /** 列出所有 queued 任务（用于监控/调试） */
  listQueued(limit = 50): StoredAnalysisJob[] {
    const rows = this.db
      .select()
      .from(analysisJobs)
      .where(eq(analysisJobs.status, 'queued'))
      .orderBy(asc(analysisJobs.createdAt))
      .limit(limit)
      .all();
    return rows.map(toStoredJob);
  }

  /** 统计各状态任务数（用于可观测） */
  countByStatus(): Record<JobStatus, number> {
    const rows = this.db
      .select({ status: analysisJobs.status, count: sql<number>`count(*)` })
      .from(analysisJobs)
      .groupBy(analysisJobs.status)
      .all();
    const result: Record<JobStatus, number> = {
      queued: 0,
      running: 0,
      succeeded: 0,
      failed: 0,
    };
    for (const row of rows) {
      if ((JOB_STATUSES as readonly string[]).includes(row.status)) {
        result[row.status as JobStatus] = Number(row.count);
      }
    }
    return result;
  }
}
