import { and, desc, eq, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { toStoredJobRunEvent, type NewJobRunEvent } from '../entities/index.js';
import type { IJobRunEventsRepository, JobRunEventPage } from '../repositories/job-run-events.js';
import { jobRunEvents as t } from './schema.js';

/** 默认页大小：与 SQLite 版同一档。 */
const PAGE_LIMIT = 200;

/** job_run_events 仓储的 Postgres 实现（全异步）。只追加，不回改。 */
export class PgJobRunEventsRepository implements IJobRunEventsRepository {
  constructor(private readonly db: PostgresJsDatabase) {}

  async insert(event: NewJobRunEvent): Promise<void> {
    await this.db.insert(t).values({
      id: event.id,
      runId: event.runId,
      event: event.event,
      fromStatus: event.fromStatus ?? null,
      toStatus: event.toStatus,
      actor: event.actor,
      payload: JSON.stringify(event.payload ?? {}),
      createdAt: event.createdAt,
    });
  }

  async listLatestPage(runId: string, limit = PAGE_LIMIT): Promise<JobRunEventPage> {
    return this.page(runId, undefined, limit);
  }

  async listOlderPage(
    runId: string,
    beforeEventId: string,
    limit = PAGE_LIMIT,
  ): Promise<JobRunEventPage | undefined> {
    // 游标定位到 ctid = 物理写入顺序，对应 SQLite 的 rowid：主键是 evt-<uuid>，字典序与
    // 时间无关，既不能当排序键也不能当游标。本表只追加不回改（仓储不暴露 UPDATE/DELETE），
    // 元组位置即写入顺序。
    const found = await this.db
      .select({ createdAt: t.createdAt, ctid: sql<string>`ctid::text` })
      .from(t)
      .where(and(eq(t.id, beforeEventId), eq(t.runId, runId)))
      .limit(1);
    const cursor = found[0];
    return cursor ? this.page(runId, cursor, limit) : undefined;
  }

  /**
   * 取一页事件：`cursor` 为 undefined 时取最新的一页，否则取该位置**之前（更早）**的一页。
   * 返回顺序永远是回放顺序（升序）。
   */
  private async page(
    runId: string,
    cursor: { createdAt: string; ctid: string } | undefined,
    limit: number,
  ): Promise<JobRunEventPage> {
    const where = [eq(t.runId, runId)];
    if (cursor) {
      // 同刻的多条迁移按 ctid 逐个跳过：一条不丢，也不重
      where.push(
        sql`(${t.createdAt} < ${cursor.createdAt} OR (${t.createdAt} = ${cursor.createdAt} AND ctid < ${cursor.ctid}::tid))`,
      );
    }
    // 哨兵行：多取一条，有就说明还有更早的，返回前剔掉（省掉一次 COUNT）
    const rows = await this.db
      .select()
      .from(t)
      .where(and(...where))
      .orderBy(desc(t.createdAt), desc(sql`ctid`))
      .limit(limit + 1);
    const hasMore = rows.length > limit;
    return {
      events: (hasMore ? rows.slice(0, limit) : rows).reverse().map(toStoredJobRunEvent),
      hasMore,
    };
  }
}
