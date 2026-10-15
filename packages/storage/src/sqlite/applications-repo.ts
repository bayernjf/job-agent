import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import {
  toStoredApplication,
  toStoredApplicationEvent,
  type ApplicationPatch,
  type ApplicationStage,
  type NewApplication,
  type NewApplicationEvent,
  type StoredApplication,
  type StoredApplicationEvent,
} from '../entities/index.js';
import type { IApplicationsRepository } from '../repositories/applications.js';
import {
  applicationEvents as evtT,
  applications as t,
  type ApplicationInsert,
} from './schema.js';

/** B3-b：审计事件入库 → drizzle values（与 job_run_events 仓储的 insert 逐字段一致） */
function toEventInsertValues(event: NewApplicationEvent) {
  return {
    id: event.id,
    applicationId: event.applicationId,
    event: event.event,
    fromStage: event.fromStage ?? null,
    toStage: event.toStage,
    actor: event.actor,
    payload: JSON.stringify(event.payload ?? {}),
    createdAt: event.createdAt,
  };
}

/** applications 仓储的 SQLite 实现（异步接口、同步驱动）。 */
export class SqliteApplicationsRepository implements IApplicationsRepository {
  constructor(private readonly db: BetterSQLite3Database) {}

  async insert(application: NewApplication): Promise<void> {
    this.db
      .insert(t)
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
        // 022：Agent 流程（标记已投）写入票据 id；其余写入保持 null
        submitIntentId: application.submitIntentId ?? null,
      })
      .run();
  }

  async getById(id: string): Promise<StoredApplication | undefined> {
    const row = this.db.select().from(t).where(eq(t.id, id)).get();
    return row ? toStoredApplication(row) : undefined;
  }

  async listByProfile(profileId: string): Promise<StoredApplication[]> {
    const rows = this.db
      .select()
      .from(t)
      .where(eq(t.profileId, profileId))
      .orderBy(desc(t.appliedAt))
      .all();
    return rows.map(toStoredApplication);
  }

  async listByJobId(jobId: string): Promise<StoredApplication[]> {
    const rows = this.db
      .select()
      .from(t)
      .where(eq(t.jobId, jobId))
      .orderBy(desc(t.appliedAt))
      .all();
    return rows.map(toStoredApplication);
  }

  async update(
    id: string,
    patch: ApplicationPatch,
    ownerAccountId?: string | null,
  ): Promise<StoredApplication | undefined> {
    if (ownerAccountId !== undefined) {
      const current = await this.getById(id);
      // 有主且主不是调用者 → 与"不存在"同形返回，不泄露他人记录的存在性
      if (current && current.createdByAccountId !== null && current.createdByAccountId !== ownerAccountId) {
        return undefined;
      }
    }
    const set: Partial<ApplicationInsert> & { updatedAt: string } = {
      updatedAt: new Date().toISOString(),
    };
    if (patch.status !== undefined) set.status = patch.status;
    if (patch.note !== undefined) set.note = patch.note;
    if (patch.appliedAt !== undefined) set.appliedAt = patch.appliedAt;
    if (patch.targetUrl !== undefined) set.targetUrl = patch.targetUrl;
    if (patch.outcomeFeedback !== undefined) set.outcomeFeedback = patch.outcomeFeedback;
    if (patch.outcomeFeedbackAt !== undefined) set.outcomeFeedbackAt = patch.outcomeFeedbackAt;
    this.db.update(t).set(set).where(eq(t.id, id)).run();
    return this.getById(id);
  }

  async deleteByProfile(profileId: string): Promise<void> {
    // B3-b（039）：事件表无外键，级联删除应用侧处理——先清该画像投递的阶段事件，再删投递，同事务。
    this.db.transaction((tx) => {
      const rows = tx.select({ id: t.id }).from(t).where(eq(t.profileId, profileId)).all();
      const ids = rows.map((r) => r.id);
      if (ids.length > 0) {
        tx.delete(evtT).where(inArray(evtT.applicationId, ids)).run();
      }
      tx.delete(t).where(eq(t.profileId, profileId)).run();
    });
  }

  async advanceStage(
    id: string,
    expectStage: ApplicationStage | null,
    toStage: ApplicationStage,
    event: NewApplicationEvent,
  ): Promise<StoredApplication | undefined> {
    // CAS 与审计事件必须同事务：消除"阶段已推进、事件丢失"的窗口（崩溃后事件流不可回放）。
    // expectStage=null 时条件必须用 IS NULL——`stage = NULL` 恒假，会把首次推进变成永远失败。
    return this.db.transaction((tx): StoredApplication | undefined => {
      const where =
        expectStage === null
          ? and(eq(t.id, id), isNull(t.stage))
          : and(eq(t.id, id), eq(t.stage, expectStage));
      const result = tx
        .update(t)
        .set({ stage: toStage, updatedAt: new Date().toISOString() })
        .where(where)
        .run();
      // CAS 输家：零事件写入
      if ((result.changes ?? 0) === 0) return undefined;
      tx.insert(evtT).values(toEventInsertValues(event)).run();
      const row = tx.select().from(t).where(eq(t.id, id)).get();
      return row ? toStoredApplication(row) : undefined;
    });
  }

  async listStageEvents(applicationId: string): Promise<StoredApplicationEvent[]> {
    // 正序回放；同刻多条按 rowid（写入序）排稳定顺序——主键 evt-<uuid> 字典序与写入无关
    const rows = this.db
      .select()
      .from(evtT)
      .where(eq(evtT.applicationId, applicationId))
      .orderBy(asc(evtT.createdAt), asc(sql`rowid`))
      .all();
    return rows.map(toStoredApplicationEvent);
  }
}
