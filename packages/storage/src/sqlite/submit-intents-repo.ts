import { and, asc, desc, eq, gte, inArray, or, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import {
  toStoredSubmitIntent,
  type JobSource,
  type NewSubmitIntent,
  type StoredSubmitIntent,
  type SubmitIntentStatus,
} from '../entities/index.js';
import type { ISubmitIntentsRepository } from '../repositories/submit-intents.js';
import { submitIntents as t } from './schema.js';

/** 计入每源每日限频的票据状态：只有"已确认/已投出"占用额度 */
const COMMITTED_STATUSES: readonly SubmitIntentStatus[] = ['approved', 'submitted'];

/** 入库输入 → drizzle values（两方言共用同一字段映射） */
function toInsertValues(intent: NewSubmitIntent) {
  return {
    id: intent.id,
    runId: intent.runId,
    accountId: intent.accountId,
    profileId: intent.profileId,
    jobId: intent.jobId,
    jobSource: intent.jobSource,
    jobSnapshot: JSON.stringify(intent.job),
    matchScore: intent.matchScore,
    matchTier: intent.matchTier,
    matchReport: JSON.stringify(intent.report),
    status: intent.status ?? 'pending',
    rejectReason: intent.rejectReason ?? null,
    approvedAt: intent.approvedAt ?? null,
    rejectedAt: intent.rejectedAt ?? null,
    submittedAt: intent.submittedAt ?? null,
    applicationId: intent.applicationId ?? null,
    createdAt: intent.createdAt,
    updatedAt: intent.updatedAt,
  };
}

/** submit_intents 仓储的 SQLite 实现（异步接口、同步驱动）。 */
export class SqliteSubmitIntentsRepository implements ISubmitIntentsRepository {
  constructor(private readonly db: BetterSQLite3Database) {}

  async insert(intent: NewSubmitIntent): Promise<void> {
    this.db.insert(t).values(toInsertValues(intent)).run();
  }

  async insertMany(intents: readonly NewSubmitIntent[]): Promise<void> {
    if (intents.length === 0) return;
    this.db
      .insert(t)
      .values(intents.map(toInsertValues))
      .run();
  }

  async getById(id: string): Promise<StoredSubmitIntent | undefined> {
    const row = this.db.select().from(t).where(eq(t.id, id)).get();
    return row ? toStoredSubmitIntent(row) : undefined;
  }

  async listByRun(runId: string, limit = 100): Promise<StoredSubmitIntent[]> {
    const rows = this.db
      .select()
      .from(t)
      .where(eq(t.runId, runId))
      .orderBy(desc(t.createdAt))
      .limit(limit)
      .all();
    return rows.map(toStoredSubmitIntent);
  }

  async listByRunAndStatus(
    runId: string,
    status: SubmitIntentStatus,
    limit = 100,
  ): Promise<StoredSubmitIntent[]> {
    const rows = this.db
      .select()
      .from(t)
      .where(and(eq(t.runId, runId), eq(t.status, status)))
      .orderBy(desc(t.createdAt))
      .limit(limit)
      .all();
    return rows.map(toStoredSubmitIntent);
  }

  async listFillableByAccount(accountId: string, limit = 100): Promise<StoredSubmitIntent[]> {
    const rows = this.db
      .select()
      .from(t)
      .where(and(eq(t.accountId, accountId), eq(t.status, 'approved')))
      .orderBy(desc(t.approvedAt))
      .limit(limit)
      .all();
    return rows.map(toStoredSubmitIntent);
  }

  async listByAccountSince(
    accountId: string,
    since: string,
    limit = 200,
  ): Promise<StoredSubmitIntent[]> {
    const rows = this.db
      .select()
      .from(t)
      .where(and(eq(t.accountId, accountId), gte(t.createdAt, since)))
      .orderBy(asc(t.createdAt))
      .limit(limit)
      .all();
    return rows.map(toStoredSubmitIntent);
  }

  async approveMany(runId: string, ids: readonly string[], approvedAt: string): Promise<number> {
    if (ids.length === 0) return 0;
    // 一条条件 UPDATE 覆盖该 run 内指定的 pending 票据；返回真正被移动的行数
    const result = this.db
      .update(t)
      .set({ status: 'approved', approvedAt, updatedAt: approvedAt })
      .where(and(eq(t.runId, runId), inArray(t.id, [...ids]), eq(t.status, 'pending')))
      .run();
    return result.changes ?? 0;
  }

  async reject(
    id: string,
    reason: string | null,
    rejectedAt: string,
  ): Promise<StoredSubmitIntent | undefined> {
    // 守卫：只有 pending 可被拒绝；已结单的行不受影响（影响 0 行 → undefined）
    const result = this.db
      .update(t)
      .set({
        status: 'rejected',
        rejectReason: reason,
        rejectedAt,
        updatedAt: rejectedAt,
      })
      .where(and(eq(t.id, id), eq(t.status, 'pending')))
      .run();
    if ((result.changes ?? 0) === 0) return undefined;
    return this.getById(id);
  }

  async markSubmitted(
    id: string,
    submittedAt: string,
    applicationId: string | null,
  ): Promise<StoredSubmitIntent | undefined> {
    // 守卫：pending 或 approved 可标记已投；rejected/withdrawn/failed 不可复活
    const result = this.db
      .update(t)
      .set({
        status: 'submitted',
        submittedAt,
        applicationId,
        updatedAt: submittedAt,
      })
      .where(and(eq(t.id, id), inArray(t.status, ['pending', 'approved'])))
      .run();
    if ((result.changes ?? 0) === 0) return undefined;
    return this.getById(id);
  }

  async countCommittedBySourceSince(
    accountId: string,
    jobSource: JobSource,
    since: string,
  ): Promise<number> {
    const row = this.db
      .select({ count: sql<number>`count(*)` })
      .from(t)
      .where(
        and(
          eq(t.accountId, accountId),
          eq(t.jobSource, jobSource),
          inArray(t.status, [...COMMITTED_STATUSES]),
          // 时间窗任一命中即算：approved_at 与 submitted_at 都是 UTC ISO8601 文本，
          // SQLite 下 gte 按文本序比较即等价于时间序
          or(gte(t.submittedAt, since), gte(t.approvedAt, since)),
        ),
      )
      .get();
    return Number(row?.count ?? 0);
  }
}
