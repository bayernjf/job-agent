import { desc, eq, sql } from 'drizzle-orm';
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
    // 与 SQLite 版同语义：取**最新** limit 条再反转成时间正序（回放顺序不变）。
    // 原先 asc + limit 会永远只返回最旧的一批，事件流在 ~16.7 小时后冻住。
    // 次级排序键 ctid = 物理写入顺序，对应 SQLite 的 rowid：主键是 evt-<uuid>，
    // 字典序与时间无关，而同一次 tick 的多条迁移共用同一个 created_at ISO 串。
    // 本表只追加不回改（仓储不暴露任何 UPDATE/DELETE），元组位置即写入顺序。
    const rows = await this.db
      .select()
      .from(t)
      .where(eq(t.runId, runId))
      .orderBy(desc(t.createdAt), desc(sql`ctid`))
      .limit(limit);
    return rows.reverse().map(toStoredJobRunEvent);
  }
}
