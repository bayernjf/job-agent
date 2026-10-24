import { and, asc, desc, eq, gte, lt, or, sql } from 'drizzle-orm';
import type { RequesterKind } from '@jobagent/shared';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import {
  toStoredJob,
  jobSucceedValues,
  type JobStage,
  type NewAnalysisJob,
  type StoredAnalysisJob,
} from '../entities/index.js';
import {
  DEFAULT_JOB_MAX_ATTEMPTS,
  type IAnalysisJobsRepository,
} from '../repositories/analysis-jobs.js';
import { analysisJobs } from './schema.js';
import { tsLt } from './time-text.js';

/** 正式（非 demo）任务优先认领的排序表达式：demo 排后，同级再按创建时间 FIFO */
const formalFirst = sql`CASE WHEN ${analysisJobs.requesterKind} = 'demo' THEN 1 ELSE 0 END`;

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

  async claimNext(
    workerId: string,
    maxAttempts: number = DEFAULT_JOB_MAX_ATTEMPTS,
  ): Promise<StoredAnalysisJob | null> {
    const now = new Date().toISOString();
    let claimedId: string | null = null;
    // 与 reclaimStaleRunning 用同一个有效上限；下限理由见该方法与 SQLite 实现。
    const cap = Math.max(1, maxAttempts);

    await this.db.transaction(async (tx) => {
      const oldest = await tx
        .select({ id: analysisJobs.id })
        .from(analysisJobs)
        .where(
          and(
            eq(analysisJobs.status, 'queued'),
            lt(analysisJobs.attempts, cap),
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
      .set(jobSucceedValues(profileId, now, budgetUsed, missing))
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

  async reclaimStaleRunning(
    maxAgeMs: number,
    maxAttempts: number = DEFAULT_JOB_MAX_ATTEMPTS,
  ): Promise<number> {
    const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
    const now = new Date().toISOString();
    // 下限 1：理由见 SQLite 实现（envPositiveInt 允许 MAX_RETRIES=0）。
    const cap = Math.max(1, maxAttempts);
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
      let moved = 0;
      await this.db.transaction(async (tx) => {
        const stale = and(
          eq(analysisJobs.status, 'running'),
          tsLt(analysisJobs.startedAt, cutoff),
        );

        // 1. 重试预算已耗尽的僵尸任务 → 终态 failed。退回 queued 会让它既不可被
        //    claimNext 认领、又永远不是终态（理由见接口契约与 SQLite 实现）。
        const exhausted = await tx
          .update(analysisJobs)
          .set({
            status: 'failed',
            stage: null,
            errorMessage:
              'Reclaimed: worker likely crashed mid-job and the retry budget is exhausted',
            claimedBy: null,
            startedAt: null,
            finishedAt: now,
            updatedAt: now,
          })
          .where(and(stale, gte(analysisJobs.attempts, cap)))
          .returning({ id: analysisJobs.id });
        moved += exhausted.length;

        // 2. 预算未耗尽 → 回 queued 等下一轮认领（原有行为）
        const requeued = await tx
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
          .where(and(stale, lt(analysisJobs.attempts, cap)))
          .returning({ id: analysisJobs.id });
        moved += requeued.length;

        // 3. 自愈：已经停在「queued 且预算耗尽」的历史行（旧版 reclaim 的产物）也落终态，
        //    既有积压因此无需数据迁移即可排干。
        const stranded = await tx
          .update(analysisJobs)
          .set({
            status: 'failed',
            stage: null,
            errorMessage:
              'Retry budget exhausted while queued; marked failed by the reclaim sweep',
            finishedAt: now,
            updatedAt: now,
          })
          .where(and(eq(analysisJobs.status, 'queued'), gte(analysisJobs.attempts, cap)))
          .returning({ id: analysisJobs.id });
        moved += stranded.length;
      });
      return moved;
    } catch (err) {
      if (diag) {
        const e = err as Error & { code?: string };
        console.error(
          '[diag:reclaim] FAIL ' +
            JSON.stringify({
              name: e?.name,
              code: e?.code,
              message: e?.message,
              cutoffType: typeof cutoff,
            }),
        );
        console.error(e?.stack);
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
