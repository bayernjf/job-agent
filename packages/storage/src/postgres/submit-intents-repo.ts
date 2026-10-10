import { and, asc, desc, eq, gte, inArray, or, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { tsGte } from './time-text.js';
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

/** 入库输入 → drizzle values（与 SQLite 实现逐字段一致） */
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

/** submit_intents 仓储的 Postgres 实现（全异步）。 */
export class PgSubmitIntentsRepository implements ISubmitIntentsRepository {
  constructor(private readonly db: PostgresJsDatabase) {}

  async insert(intent: NewSubmitIntent): Promise<void> {
    await this.db.insert(t).values(toInsertValues(intent));
  }

  async insertMany(intents: readonly NewSubmitIntent[]): Promise<void> {
    if (intents.length === 0) return;
    await this.db.insert(t).values(intents.map(toInsertValues));
  }

  async getById(id: string): Promise<StoredSubmitIntent | undefined> {
    const rows = await this.db.select().from(t).where(eq(t.id, id)).limit(1);
    return rows[0] ? toStoredSubmitIntent(rows[0]) : undefined;
  }

  async listByRun(runId: string, limit = 100): Promise<StoredSubmitIntent[]> {
    const rows = await this.db
      .select()
      .from(t)
      .where(eq(t.runId, runId))
      .orderBy(desc(t.createdAt))
      .limit(limit);
    return rows.map(toStoredSubmitIntent);
  }

  async listByAccountSince(
    accountId: string,
    since: string,
    limit = 200,
  ): Promise<StoredSubmitIntent[]> {
    const rows = await this.db
      .select()
      .from(t)
      .where(and(eq(t.accountId, accountId), gte(t.createdAt, since)))
      .orderBy(asc(t.createdAt))
      .limit(limit);
    return rows.map(toStoredSubmitIntent);
  }

  async listByRunAndStatus(
    runId: string,
    status: SubmitIntentStatus,
    limit = 100,
  ): Promise<StoredSubmitIntent[]> {
    const rows = await this.db
      .select()
      .from(t)
      .where(and(eq(t.runId, runId), eq(t.status, status)))
      .orderBy(desc(t.createdAt))
      .limit(limit);
    return rows.map(toStoredSubmitIntent);
  }

  async listFillableByAccount(accountId: string, limit = 100): Promise<StoredSubmitIntent[]> {
    const rows = await this.db
      .select()
      .from(t)
      .where(and(eq(t.accountId, accountId), eq(t.status, 'approved')))
      .orderBy(desc(t.approvedAt))
      .limit(limit);
    return rows.map(toStoredSubmitIntent);
  }

  async approveMany(runId: string, ids: readonly string[], approvedAt: string): Promise<number> {
    if (ids.length === 0) return 0;
    // 一条条件 UPDATE 覆盖该 run 内指定的 pending 票据；RETURNING 的行数即真正被移动的行数
    const rows = await this.db
      .update(t)
      .set({ status: 'approved', approvedAt, updatedAt: approvedAt })
      .where(and(eq(t.runId, runId), inArray(t.id, [...ids]), eq(t.status, 'pending')))
      .returning({ id: t.id });
    return rows.length;
  }

  async reject(
    id: string,
    reason: string | null,
    rejectedAt: string,
  ): Promise<StoredSubmitIntent | undefined> {
    // 守卫：只有 pending 可被拒绝；已结单的行不受影响（RETURNING 为空 → undefined）
    const rows = await this.db
      .update(t)
      .set({
        status: 'rejected',
        rejectReason: reason,
        rejectedAt,
        updatedAt: rejectedAt,
      })
      .where(and(eq(t.id, id), eq(t.status, 'pending')))
      .returning({ id: t.id });
    if (rows.length === 0) return undefined;
    return this.getById(id);
  }

  async markSubmitted(
    id: string,
    submittedAt: string,
    applicationId: string | null,
  ): Promise<StoredSubmitIntent | undefined> {
    // 守卫：pending 或 approved 可标记已投；rejected/withdrawn/failed 不可复活
    const rows = await this.db
      .update(t)
      .set({
        status: 'submitted',
        submittedAt,
        applicationId,
        updatedAt: submittedAt,
      })
      .where(and(eq(t.id, id), inArray(t.status, ['pending', 'approved'])))
      .returning({ id: t.id });
    if (rows.length === 0) return undefined;
    return this.getById(id);
  }

  async countCommittedBySourceSince(
    accountId: string,
    jobSource: JobSource,
    since: string,
  ): Promise<number> {
    const rows = await this.db
      .select({ count: sql<string>`count(*)` })
      .from(t)
      .where(
        and(
          eq(t.accountId, accountId),
          eq(t.jobSource, jobSource),
          inArray(t.status, [...COMMITTED_STATUSES]),
          // 时间窗任一命中即算。两个时间戳列都是 TEXT，比较参数必须用 time-text 的
          // ::text 定型：经事务池化（prepare=false）时未定型参数会被推断成 timestamptz，
          // 触发 42883 "operator does not exist: text >= timestamp with time zone"。
          or(tsGte(t.submittedAt, since), tsGte(t.approvedAt, since)),
        ),
      );
    return Number(rows[0]?.count ?? 0);
  }
}
