import { and, asc, desc, eq, lt, or, sql } from 'drizzle-orm';
import type { RequesterKind } from '@jobagent/shared';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import {
  toStoredJob,
  type JobStage,
  type NewAnalysisJob,
  type StoredAnalysisJob,
} from '../entities/index.js';
import type { IAnalysisJobsRepository } from '../repositories/analysis-jobs.js';
import { analysisJobs } from './schema.js';

/** 正式（非 demo）任务优先认领的排序表达式：demo 排后，同级再按创建时间 FIFO */
const formalFirst = sql`CASE WHEN ${analysisJobs.requesterKind} = 'demo' THEN 1 ELSE 0 END`;

/**
 * analysis_jobs 仓储的 SQLite 实现（异步接口、同步驱动）。
 * 认领操作为本地同步事务：queued -> running，attempts+1，正式优先、同级最老一行。
 */
export class SqliteAnalysisJobsRepository implements IAnalysisJobsRepository {
  constructor(private readonly db: BetterSQLite3Database) {}

  async create(job: NewAnalysisJob): Promise<void> {
    this.db
      .insert(analysisJobs)
      .values({
        id: job.id,
        subjectPlatform: job.subjectPlatform ?? 'github',
        subjectLogin: job.subjectLogin,
        status: 'queued',
        attempts: 0,
        requesterKind: job.requesterKind ?? 'public',
        demoSessionId: job.demoSessionId ?? null,
      })
      .run();
  }

  async getById(id: string): Promise<StoredAnalysisJob | undefined> {
    const row = this.db.select().from(analysisJobs).where(eq(analysisJobs.id, id)).get();
    return row ? toStoredJob(row) : undefined;
  }

  async claimNext(workerId: string): Promise<StoredAnalysisJob | null> {
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
        // 正式（public/未来 user）优先于 demo，同级再按创建时间 FIFO
        .orderBy(formalFirst, asc(analysisJobs.createdAt))
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
    return (await this.getById(claimedId)) ?? null;
  }

  async countRunningByRequesterKind(kind: RequesterKind | 'public'): Promise<number> {
    const row = this.db
      .select({ count: sql<number>`count(*)` })
      .from(analysisJobs)
      .where(
        and(
          eq(analysisJobs.status, 'running'),
          eq(analysisJobs.requesterKind, kind),
        ),
      )
      .get();
    return Number(row?.count ?? 0);
  }

  async updateStage(id: string, stage: JobStage): Promise<void> {
    this.db
      .update(analysisJobs)
      .set({ stage, updatedAt: new Date().toISOString() })
      .where(eq(analysisJobs.id, id))
      .run();
  }

  async succeed(
    id: string,
    profileId: string,
    budgetUsed?: Record<string, number>,
    missing?: string[],
  ): Promise<void> {
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

  async fail(id: string, errorMessage: string): Promise<void> {
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

  async resetToQueued(id: string, lastError: string): Promise<void> {
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

  async reclaimStaleRunning(maxAgeMs: number): Promise<number> {
    const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
    const now = new Date().toISOString();
    const result = this.db
      .update(analysisJobs)
      .set({
        status: 'queued',
        stage: null,
        errorMessage: 'Reclaimed: worker likely crashed mid-job',
        claimedBy: null,
        startedAt: null,
        finishedAt: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(analysisJobs.status, 'running'),
          lt(analysisJobs.startedAt, cutoff),
        ),
      )
      .run();
    return result.changes ?? 0;
  }

  async listBySubject(
    subjectPlatform: string,
    subjectLogin: string,
    limit = 20,
  ): Promise<StoredAnalysisJob[]> {
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

  async latestActiveBySubject(
    subjectPlatform: string,
    subjectLogin: string,
  ): Promise<StoredAnalysisJob | undefined> {
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

  async listQueued(limit = 50): Promise<StoredAnalysisJob[]> {
    const rows = this.db
      .select()
      .from(analysisJobs)
      .where(eq(analysisJobs.status, 'queued'))
      .orderBy(asc(analysisJobs.createdAt))
      .limit(limit)
      .all();
    return rows.map(toStoredJob);
  }

  async countByStatus(): Promise<Record<string, number>> {
    const rows = this.db
      .select({ status: analysisJobs.status, count: sql<number>`count(*)` })
      .from(analysisJobs)
      .groupBy(analysisJobs.status)
      .all();
    const result: Record<string, number> = {
      queued: 0,
      running: 0,
      succeeded: 0,
      failed: 0,
    };
    for (const row of rows) {
      result[row.status] = Number(row.count);
    }
    return result;
  }
}
