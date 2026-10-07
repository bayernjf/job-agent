import { asc, eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import {
  toStoredCronHeartbeat,
  type StoredCronHeartbeat,
} from '../entities/index.js';
import type { ICronHeartbeatRepository } from '../repositories/cron-heartbeat.js';
import { cronHeartbeat as t } from './schema.js';

/** cron_heartbeat 仓储的 SQLite 实现。 */
export class SqliteCronHeartbeatRepository implements ICronHeartbeatRepository {
  constructor(private readonly db: BetterSQLite3Database) {}

  async recordSuccess(consumer: string, atIso: string, result: string): Promise<void> {
    this.db
      .insert(t)
      .values({
        consumer,
        lastSuccessAt: atIso,
        lastResult: result,
        lastError: null,
        updatedAt: atIso,
      })
      .onConflictDoUpdate({
        target: t.consumer,
        set: { lastSuccessAt: atIso, lastResult: result, lastError: null, updatedAt: atIso },
      })
      .run();
  }

  async recordFailure(consumer: string, atIso: string, error: string): Promise<void> {
    // 只动 last_error 与 updated_at：保留最后一次成功信息供读口对照
    this.db
      .insert(t)
      .values({ consumer, lastSuccessAt: null, lastResult: null, lastError: error, updatedAt: atIso })
      .onConflictDoUpdate({
        target: t.consumer,
        set: { lastError: error, updatedAt: atIso },
      })
      .run();
  }

  async listAll(): Promise<StoredCronHeartbeat[]> {
    const rows = this.db.select().from(t).orderBy(asc(t.consumer)).all();
    return rows.map(toStoredCronHeartbeat);
  }
}
