import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import {
  toStoredJobRun,
  type JobRunStatus,
  type JobRunStatusPatch,
  type NewJobRun,
  type StoredJobRun,
} from '../entities/index.js';
import type { IJobRunsRepository } from '../repositories/job-runs.js';
import { jobRuns as t, type JobRunInsert } from './schema.js';

/** 状态补丁 → drizzle set 对象：只写显式提供的字段（null 是合法值） */
function patchToSet(patch: JobRunStatusPatch): Partial<JobRunInsert> & { updatedAt: string } {
  const set: Partial<JobRunInsert> & { updatedAt: string } = {
    status: patch.status,
    updatedAt: patch.updatedAt,
  };
  if (patch.attempts !== undefined) set.attempts = patch.attempts;
  if (patch.lastError !== undefined) set.lastError = patch.lastError;
  if (patch.lastScanAt !== undefined) set.lastScanAt = patch.lastScanAt;
  return set;
}

/** job_runs 仓储的 SQLite 实现（异步接口、同步驱动）。 */
export class SqliteJobRunsRepository implements IJobRunsRepository {
  constructor(private readonly db: BetterSQLite3Database) {}

  async insert(run: NewJobRun): Promise<void> {
    this.db
      .insert(t)
      .values({
        id: run.id,
        accountId: run.accountId,
        profileId: run.profileId,
        preferenceId: run.preferenceId,
        // 新任务一律从 created 起步，推进只能走状态补丁
        status: 'created',
        attempts: 0,
        createdAt: run.createdAt,
        updatedAt: run.createdAt,
      })
      .run();
  }

  async getById(id: string): Promise<StoredJobRun | undefined> {
    const row = this.db.select().from(t).where(eq(t.id, id)).get();
    return row ? toStoredJobRun(row) : undefined;
  }

  async listByAccount(accountId: string, limit = 50): Promise<StoredJobRun[]> {
    const rows = this.db
      .select()
      .from(t)
      .where(eq(t.accountId, accountId))
      .orderBy(desc(t.createdAt))
      .limit(limit)
      .all();
    return rows.map(toStoredJobRun);
  }

  async compareAndSetStatus(
    id: string,
    expectStatus: JobRunStatus,
    patch: JobRunStatusPatch,
  ): Promise<StoredJobRun | undefined> {
    // 单条条件 UPDATE：状态不符则影响 0 行，这是 cron 与手动扫描之间的互斥闸
    const result = this.db
      .update(t)
      .set(patchToSet(patch))
      .where(and(eq(t.id, id), eq(t.status, expectStatus)))
      .run();
    if ((result.changes ?? 0) === 0) return undefined;
    return this.getById(id);
  }

  async setStatus(
    id: string,
    patch: JobRunStatusPatch,
  ): Promise<StoredJobRun | undefined> {
    this.db.update(t).set(patchToSet(patch)).where(eq(t.id, id)).run();
    return this.getById(id);
  }

  async markViewed(id: string, viewedAt: string): Promise<StoredJobRun | undefined> {
    // 只写 last_viewed_at：不推进状态、不碰 updated_at（查看不影响调度排序）
    const result = this.db.update(t).set({ lastViewedAt: viewedAt }).where(eq(t.id, id)).run();
    if ((result.changes ?? 0) === 0) return undefined;
    return this.getById(id);
  }

  async listByStatuses(
    statuses: readonly JobRunStatus[],
    limit = 20,
  ): Promise<StoredJobRun[]> {
    if (statuses.length === 0) return [];
    const rows = this.db
      .select()
      .from(t)
      .where(inArray(t.status, [...statuses]))
      // SQLite 的 NULL 小于一切值，ASC 天然把"从未扫描"排在最前
      .orderBy(asc(t.lastScanAt), asc(t.createdAt))
      .limit(limit)
      .all();
    return rows.map(toStoredJobRun);
  }
}
