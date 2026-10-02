import { asc, eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import {
  toStoredJobRunEvent,
  type NewJobRunEvent,
  type StoredJobRunEvent,
} from '../entities/index.js';
import type { IJobRunEventsRepository } from '../repositories/job-run-events.js';
import { jobRunEvents as t } from './schema.js';

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

  async listByRun(runId: string, limit = 200): Promise<StoredJobRunEvent[]> {
    const rows = await this.db
      .select()
      .from(t)
      .where(eq(t.runId, runId))
      // 事件流按时间正序（回放顺序），与 submit_intents 的"最新在前"相反
      .orderBy(asc(t.createdAt))
      .limit(limit);
    return rows.map(toStoredJobRunEvent);
  }
}
