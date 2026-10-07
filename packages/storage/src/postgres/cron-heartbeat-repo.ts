import { asc, eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import {
  toStoredCronHeartbeat,
  type StoredCronHeartbeat,
} from '../entities/index.js';
import type { ICronHeartbeatRepository } from '../repositories/cron-heartbeat.js';
import { cronHeartbeat as t } from './schema.js';

/** cron_heartbeat 仓储的 Postgres 实现。 */
export class PgCronHeartbeatRepository implements ICronHeartbeatRepository {
  constructor(private readonly db: PostgresJsDatabase) {}

  async recordSuccess(consumer: string, atIso: string, result: string): Promise<void> {
    await this.db
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
      });
  }

  async recordFailure(consumer: string, atIso: string, error: string): Promise<void> {
    await this.db
      .insert(t)
      .values({
        consumer,
        lastSuccessAt: null,
        lastResult: null,
        lastError: error,
        updatedAt: atIso,
      })
      .onConflictDoUpdate({
        target: t.consumer,
        set: { lastError: error, updatedAt: atIso },
      });
  }

  async listAll(): Promise<StoredCronHeartbeat[]> {
    const rows = await this.db.select().from(t).orderBy(asc(t.consumer));
    return rows.map(toStoredCronHeartbeat);
  }
}
