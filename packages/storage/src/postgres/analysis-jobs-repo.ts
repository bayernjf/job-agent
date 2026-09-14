import { and, asc, desc, eq, lt, or, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import {
  toStoredJob,
  type JobStage,
  type NewAnalysisJob,
  type StoredAnalysisJob,
} from '../entities/index.js';
import type { IAnalysisJobsRepository } from '../repositories/analysis-jobs.js';
import { analysisJobs } from './schema.js';

/**
 * analysis_jobs 仓储的 Postgres 实现。
 * 认领在 async 事务内两步完成（SELECT 最老 queued → UPDATE 特定 id 双校验）。
 * MVP 单 Worker，FOR UPDATE SKIP LOCKED 缓做（设计文档 §9）。
 */
export class PgAnalysisJobsRepository implements IAnalysisJobsRepository {
  constructor(private readonly db: PostgresJsDatabase) {}

  async create(job: NewAnalysisJob): Promise<void> {
    await this.db.insert(analysisJobs).values({
      id: job.id,
      subjectPlatform: job.subjectPlatform ?? 'github',
      subjectLogin: job.subjectLogin,
      status: 'queued',
      attempts: 0,
    });
  }

  async getById(id: string): Promise<StoredAnalysisJob | undefined> {
    const rows = await this.db.select().from(analysisJobs).where(eq(analysisJobs.id, id)).limit(1);
    return rows[0] ? toStoredJob(rows[0]) : undefined;
  }

  async claimNext(workerId: string): Promise<StoredAnalysisJob | null> {
    const now = new Date().toISOString();
    let claimedId: string | null = null;

    await this.db.transaction(async (tx) => {
      const oldest = await tx
        .select({ id: analysisJobs.id })
        .from(analysisJobs)
        .where(
          and(
            eq(analysisJobs.status, 'queued'),
            lt(analysisJobs.attempts, 3),
          ),
        )
        .orderBy(asc(analysisJobs.createdAt))
        .limit(1);

      if (oldest.length === 0) return;

      const updated = await tx
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
            eq(analysisJobs.id, oldest[0]!.id),
            eq(analysisJobs.status, 'queued'),
          ),
        )
        .returning({ id: analysisJobs.id });

      if (updated.length > 0) claimedId = updated[0]!.id;
    });

    if (!claimedId) return null;
    return (await this.getById(claimedId)) ?? null;
  }

  async updateStage(id: string, stage: JobStage): Promise<void> {
    await this.db
      .update(analysisJobs)
      .set({ stage, updatedAt: new Date().toISOString() })
      .where(eq(analysisJobs.id, id));
  }

  async succeed(
    id: string,
    profileId: string,
    budgetUsed?: Record<string, number>,
    missing?: string[],
  ): Promise<void> {
    const now = new Date().toISOString();
    await this.db
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
      .where(eq(analysisJobs.id, id));
  }

  async fail(id: string, errorMessage: string): Promise<void> {
    const now = new Date().toISOString();
    await this.db
      .update(analysisJobs)
      .set({ status: 'failed', errorMessage, finishedAt: now, updatedAt: now })
      .where(eq(analysisJobs.id, id));
  }

  async resetToQueued(id: string, lastError: string): Promise<void> {
    const now = new Date().toISOString();
    await this.db
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
      .where(eq(analysisJobs.id, id));
  }

  async reclaimStaleRunning(maxAgeMs: number): Promise<number> {
    const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
    const now = new Date().toISOString();
    const result = await this.db
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
      .returning({ id: analysisJobs.id });
    return result.length;
  }

  async listBySubject(
    subjectPlatform: string,
    subjectLogin: string,
    limit = 20,
  ): Promise<StoredAnalysisJob[]> {
    const rows = await this.db
      .select()
      .from(analysisJobs)
      .where(
        and(
          eq(analysisJobs.subjectPlatform, subjectPlatform),
          eq(analysisJobs.subjectLogin, subjectLogin),
        ),
      )
      .orderBy(desc(analysisJobs.createdAt))
      .limit(limit);
    return rows.map(toStoredJob);
  }

  async latestActiveBySubject(
    subjectPlatform: string,
    subjectLogin: string,
  ): Promise<StoredAnalysisJob | undefined> {
    const rows = await this.db
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
      .limit(1);
    return rows[0] ? toStoredJob(rows[0]) : undefined;
  }

  async listQueued(limit = 50): Promise<StoredAnalysisJob[]> {
    const rows = await this.db
      .select()
      .from(analysisJobs)
      .where(eq(analysisJobs.status, 'queued'))
      .orderBy(asc(analysisJobs.createdAt))
      .limit(limit);
    return rows.map(toStoredJob);
  }

  async countByStatus(): Promise<Record<string, number>> {
    const rows = await this.db
      .select({ status: analysisJobs.status, count: sql<string>`count(*)` })
      .from(analysisJobs)
      .groupBy(analysisJobs.status);
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
