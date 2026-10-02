import { asc, eq } from 'drizzle-orm';
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
    const rows = this.db
      .select()
      .from(t)
      .where(eq(t.runId, runId))
      // 事件流按时间正序（回放顺序），与 submit_intents 的"最新在前"相反
      .orderBy(asc(t.createdAt))
      .limit(limit)
      .all();
    return rows.map(toStoredJobRunEvent);
  }
}
