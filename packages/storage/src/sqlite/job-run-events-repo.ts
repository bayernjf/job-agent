import { and, desc, eq, lt, or, sql, type SQL } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import {
  toStoredJobRunEvent,
  type NewJobRunEvent,
} from '../entities/index.js';
import type { IJobRunEventsRepository, JobRunEventPage } from '../repositories/job-run-events.js';
import { jobRunEvents as t } from './schema.js';

/** 默认页大小：一屏折叠后的事件流只有几行，200 条足够覆盖一整天的自迁移。 */
const PAGE_LIMIT = 200;

/** job_run_events 仓储的 SQLite 实现（异步接口、同步驱动）。只追加，不回改。 */
export class SqliteJobRunEventsRepository implements IJobRunEventsRepository {
  constructor(private readonly db: BetterSQLite3Database) {}

  async insert(event: NewJobRunEvent): Promise<void> {
    this.db
      .insert(t)
      .values({
        id: event.id,
        runId: event.runId,
        event: event.event,
        fromStatus: event.fromStatus ?? null,
        toStatus: event.toStatus,
        actor: event.actor,
        payload: JSON.stringify(event.payload ?? {}),
        createdAt: event.createdAt,
      })
      .run();
  }

  async listLatestPage(runId: string, limit = PAGE_LIMIT): Promise<JobRunEventPage> {
    return this.page(runId, undefined, limit);
  }

  async listOlderPage(
    runId: string,
    beforeEventId: string,
    limit = PAGE_LIMIT,
  ): Promise<JobRunEventPage | undefined> {
    // 游标定位到 rowid = 写入顺序（本表 append-only、仓储不暴露 UPDATE/DELETE，故它单调
    // 即时间序）。主键 evt-<uuid> 的字典序与时间无关，既不能当排序键也不能当游标。
    const cursor = this.db
      .select({ createdAt: t.createdAt, rowid: sql<number>`rowid` })
      .from(t)
      .where(and(eq(t.id, beforeEventId), eq(t.runId, runId)))
      .get();
    return cursor ? this.page(runId, cursor, limit) : undefined;
  }

  /**
   * 取一页事件：`cursor` 为 undefined 时取最新的一页，否则取该位置**之前（更早）**的一页。
   * 返回顺序永远是回放顺序（升序）。
   */
  private page(
    runId: string,
    cursor: { createdAt: string; rowid: number } | undefined,
    limit: number,
  ): JobRunEventPage {
    const where = [eq(t.runId, runId)];
    if (cursor) {
      // 同刻的多条迁移按 rowid 逐个跳过：一条不丢，也不重
      where.push(
        sql`(${t.createdAt} < ${cursor.createdAt} OR (${t.createdAt} = ${cursor.createdAt} AND rowid < ${cursor.rowid}))`,
      );
    }
    // 哨兵行：多取一条，有就说明还有更早的，返回前剔掉（省掉一次 COUNT）
    const rows = this.db
      .select()
      .from(t)
      .where(and(...where))
      .orderBy(desc(t.createdAt), desc(sql`rowid`))
      .limit(limit + 1)
      .all();
    const hasMore = rows.length > limit;
    return {
      events: (hasMore ? rows.slice(0, limit) : rows).reverse().map(toStoredJobRunEvent),
      hasMore,
    };
  }
}
