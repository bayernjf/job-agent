import { and, asc, desc, eq, gte, inArray, or, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import {
  toStoredApplication,
  toStoredSubmitIntent,
  type JobSource,
  type NewApplication,
  type NewSubmitIntent,
  type StoredApplication,
  type StoredSubmitIntent,
  type SubmitIntentStatus,
} from '../entities/index.js';
import type {
  ApproveManyWithQuotaResult,
  ISubmitIntentsRepository,
  MarkSubmittedWithApplicationResult,
} from '../repositories/submit-intents.js';
import { applications as appT, submitIntents as t } from './schema.js';

/** 计入每源每日限频的票据状态：只有"已确认/已投出"占用额度 */
const COMMITTED_STATUSES: readonly SubmitIntentStatus[] = ['approved', 'submitted'];

/** better-sqlite3 的唯一约束错误（新版本 code 精确到 UNIQUE，旧版本靠消息兜底） */
function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; message?: string };
  return (
    e?.code === 'SQLITE_CONSTRAINT_UNIQUE' ||
    (e?.code === 'SQLITE_CONSTRAINT' &&
      typeof e.message === 'string' &&
      e.message.startsWith('UNIQUE constraint failed'))
  );
}

/** 入库输入 → drizzle values（两方言共用同一字段映射；job-runs 仓储的跨表事务同样复用） */
export function toInsertValues(intent: NewSubmitIntent) {
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

  async approveManyWithQuota(
    runId: string,
    accountId: string,
    ids: readonly string[],
    dailyLimit: number,
    since: string,
    approvedAt: string,
  ): Promise<ApproveManyWithQuotaResult> {
    if (ids.length === 0) return { outcome: 'approved', approved: 0 };
    // 判额与 UPDATE 在同一事务：SQLite 单写者串行，读之间不可能插入并发确认
    return this.db.transaction((tx): ApproveManyWithQuotaResult => {
      // ① 本次真正能移动的 pending 票据按来源分组（已被并发处理的自动剔除）
      const pendingRows = tx
        .select({
          source: sql<JobSource>`${t.jobSource}`,
          count: sql<number>`count(*)`,
        })
        .from(t)
        .where(and(eq(t.runId, runId), inArray(t.id, [...ids]), eq(t.status, 'pending')))
        .groupBy(t.jobSource)
        .all();

      // ②③ 逐来源叠加 24h 已确认/已投计数；任一超限整事务回滚（此时尚无写入）
      for (const row of pendingRows) {
        const requested = Number(row.count ?? 0);
        const committedRow = tx
          .select({ count: sql<number>`count(*)` })
          .from(t)
          .where(
            and(
              eq(t.accountId, accountId),
              eq(t.jobSource, row.source),
              inArray(t.status, [...COMMITTED_STATUSES]),
              or(gte(t.submittedAt, since), gte(t.approvedAt, since)),
            ),
          )
          .get();
        const committed = Number(committedRow?.count ?? 0);
        if (committed + requested > dailyLimit) {
          return {
            outcome: 'quota_exceeded',
            source: row.source,
            committed,
            remaining: Math.max(0, dailyLimit - committed),
            requested,
          };
        }
      }

      // ④ 全部通过：条件 UPDATE，只移动仍为 pending 的票据
      const result = tx
        .update(t)
        .set({ status: 'approved', approvedAt, updatedAt: approvedAt })
        .where(and(eq(t.runId, runId), inArray(t.id, [...ids]), eq(t.status, 'pending')))
        .run();
      return { outcome: 'approved', approved: result.changes ?? 0 };
    });
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

  async markSubmittedWithApplication(
    intentId: string,
    application: NewApplication,
    submittedAt: string,
  ): Promise<MarkSubmittedWithApplicationResult> {
    // better-sqlite3 事务在回调抛错时自动回滚；SQLite 单写者，事务内 SELECT→CAS→INSERT 串行原子
    return this.db.transaction((tx): MarkSubmittedWithApplicationResult => {
      const current = tx.select().from(t).where(eq(t.id, intentId)).get();
      if (!current) return { outcome: 'invalid' };

      const existingRow = tx
        .select()
        .from(appT)
        .where(eq(appT.submitIntentId, intentId))
        .get();
      const existing: StoredApplication | undefined = existingRow
        ? toStoredApplication(existingRow)
        : undefined;

      // 已投票据：重复/并发标记幂等返回，不再 CAS、不再插第二条
      if (current.status === 'submitted') {
        return { outcome: 'already', intent: toStoredSubmitIntent(current), application: existing };
      }
      if (current.status !== 'pending' && current.status !== 'approved') {
        return { outcome: 'invalid' };
      }

      const result = tx
        .update(t)
        .set({
          status: 'submitted',
          submittedAt,
          applicationId: application.id,
          updatedAt: submittedAt,
        })
        .where(and(eq(t.id, intentId), inArray(t.status, ['pending', 'approved'])))
        .run();
      if ((result.changes ?? 0) === 0) return { outcome: 'invalid' };

      // 035 之前的历史孤儿行（票据仍 pending/approved 但 application 已存在）：
      // 不重复插入，按幂等返回既有行，CAS 已把票据补齐为 submitted
      if (existing) {
        const refreshed = tx.select().from(t).where(eq(t.id, intentId)).get()!;
        return {
          outcome: 'already',
          intent: toStoredSubmitIntent(refreshed),
          application: existing,
        };
      }

      try {
        tx.insert(appT)
          .values({
            id: application.id,
            profileId: application.profileId,
            jobId: application.jobId ?? null,
            source: application.source ?? null,
            targetTitle: application.targetTitle,
            targetCompany: application.targetCompany,
            targetUrl: application.targetUrl ?? null,
            status: application.status ?? 'applied',
            note: application.note ?? null,
            origin: application.origin ?? 'manual',
            appliedAt: application.appliedAt,
            createdByAccountId: application.createdByAccountId ?? null,
            submitIntentId: application.submitIntentId ?? intentId,
          })
          .run();
      } catch (err) {
        // 唯一约束撞车：SQLite 下仅语句级回滚，事务仍提交（CAS 保留），按幂等读既有行
        if (!isUniqueViolation(err)) throw err;
        const winner = tx
          .select()
          .from(appT)
          .where(eq(appT.submitIntentId, intentId))
          .get();
        const latest = tx.select().from(t).where(eq(t.id, intentId)).get()!;
        return {
          outcome: 'already',
          intent: toStoredSubmitIntent(latest),
          application: winner ? toStoredApplication(winner) : undefined,
        };
      }

      const intent = tx.select().from(t).where(eq(t.id, intentId)).get()!;
      const stored = tx.select().from(appT).where(eq(appT.id, application.id)).get()!;
      return {
        outcome: 'submitted',
        intent: toStoredSubmitIntent(intent),
        application: toStoredApplication(stored),
      };
    });
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
