import { desc, eq, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import {
  toStoredJobRunEvent,
  type NewJobRunEvent,
  type StoredJobRunEvent,
} from '../entities/index.js';
import type { IJobRunEventsRepository } from '../repositories/job-run-events.js';
import { jobRunEvents as t } from './schema.js';

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

  async listByRun(runId: string, limit = 200): Promise<StoredJobRunEvent[]> {
    // 取**最新** limit 条，再反转成时间正序返回（回放顺序不变）。
    // 原先是 asc + limit，等于永远只给最旧的一批：一个每 5 分钟落一条自迁移事件的
    // run，在 ~16.7 小时后界面就再也看不到新事件——系统在跑，审计流却冻住。
    // 次级排序键是 rowid（本表主键是 evt-<uuid>，字典序与时间无关；同一次 tick 的多条
    // 迁移共用同一个 createdAt ISO，缺了这个键回放顺序就是乱的）。表是 append-only、
    // 只追加不回改，所以 rowid 单调递增就等于写入顺序。
    const rows = this.db
      .select()
      .from(t)
      .where(eq(t.runId, runId))
      .orderBy(desc(t.createdAt), desc(sql`rowid`))
      .limit(limit)
      .all();
    return rows.reverse().map(toStoredJobRunEvent);
  }
}
