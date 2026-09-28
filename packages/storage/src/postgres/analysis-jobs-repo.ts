import { and, asc, desc, eq, lt, or, sql } from 'drizzle-orm';
import type { RequesterKind } from '@jobagent/shared';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import {
  toStoredJob,
  type JobStage,
  type NewAnalysisJob,
  type StoredAnalysisJob,
} from '../entities/index.js';
import type { IAnalysisJobsRepository } from '../repositories/analysis-jobs.js';
import { analysisJobs } from './schema.js';
import { tsLt } from './time-text.js';

/** 正式（非 demo）任务优先认领的排序表达式：demo 排后，同级再按创建时间 FIFO */
const formalFirst = sql`CASE WHEN ${analysisJobs.requesterKind} = 'demo' THEN 1 ELSE 0 END`;

/**
 * TEMPORARY (JA_PG_DIAG-gated): serialize a possibly-wrapped PG error.
 * Drizzle wraps postgres-js PostgresError as `new Error("Failed query: ...",
 * { cause: e })`, stripping code/severity/hint from the top level, so the
 * whole cause chain must be walked to surface the real server-side failure.
 */
function serializePgError(err: unknown): unknown {
  const chain: unknown[] = [];
  let cur: unknown = err;
  for (let depth = 0; depth < 5 && cur; depth += 1) {
    const e = cur as Record<string, unknown>;
    const entry: Record<string, unknown> = {
      name: e.name,
      code: e.code,
      severity: e.severity,
      hint: e.hint,
      detail: e.detail,
      where: e.where,
      schemaName: e.schemaName,
      tableName: e.tableName,
      columnName: e.columnName,
      dataType: e.dataType,
      constraintName: e.constraintName,
      message: e.message,
    };
    for (const key of Object.keys(entry)) {
      if (entry[key] === undefined) delete entry[key];
    }
    chain.push(entry);
    cur = e.cause;
  }
  return chain;
}

/**
 * analysis_jobs 仓储的 Postgres 实现。
 * 认领在 async 事务内两步完成（SELECT 最老 queued → UPDATE 特定 id 双校验）；
 * 正式优先、同级 FIFO。MVP 单 Worker，FOR UPDATE SKIP LOCKED 缓做（设计文档 §9）。
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
      requesterKind: job.requesterKind ?? 'public',
      demoSessionId: job.demoSessionId ?? null,
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
        // 正式（public/未来 user）优先于 demo，同级再按创建时间 FIFO
        .orderBy(formalFirst, asc(analysisJobs.createdAt))
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

  async countRunningByRequesterKind(kind: RequesterKind | 'public'): Promise<number> {
    const rows = await this.db
      .select({ count: sql<string>`count(*)` })
      .from(analysisJobs)
      .where(
        and(
          eq(analysisJobs.status, 'running'),
          eq(analysisJobs.requesterKind, kind),
        ),
      );
    return Number(rows[0]?.count ?? 0);
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

  async deferToQueued(id: string, note: string): Promise<void> {
    const now = new Date().toISOString();
    await this.db
      .update(analysisJobs)
      .set({
        status: 'queued',
        stage: null,
        claimedBy: null,
        startedAt: null,
        finishedAt: null,
        // 抵消本次 claimNext 的 attempts+1，反复 defer 不耗尽重试预算
        attempts: sql`GREATEST(${analysisJobs.attempts} - 1, 0)`,
        updatedAt: now,
      })
      .where(eq(analysisJobs.id, id));
    void note;
  }

  async reclaimStaleRunning(maxAgeMs: number): Promise<number> {
    const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
    const now = new Date().toISOString();
    const diag = process.env.JA_PG_DIAG === '1';
    if (diag) {
      // TEMPORARY production probe for the text-column vs timestamptz 42883
      // failure: proves the JS type of the comparison parameter at runtime.
      console.info(
        '[diag:reclaim] ' +
          JSON.stringify({ cutoffType: typeof cutoff, cutoff, nowType: typeof now, maxAgeMs }),
      );
    }
    try {
      if (diag) {
        const schema = await this.db.execute(
          sql`select data_type, udt_name from information_schema.columns
              where table_schema = 'public'
                and table_name = 'analysis_jobs'
                and column_name in ('started_at', 'updated_at')
              order by column_name`,
        );
        console.info(`[diag:columns] ${JSON.stringify(Array.from(schema))}`);
      }
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
            tsLt(analysisJobs.startedAt, cutoff),
          ),
        )
        .returning({ id: analysisJobs.id });
      return result.length;
    } catch (err) {
      if (diag) {
        console.error('[diag:reclaim] FAIL ' + JSON.stringify(serializePgError(err)));
      }
      throw err;
    }
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
