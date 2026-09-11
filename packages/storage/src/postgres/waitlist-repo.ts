import { desc, eq, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import {
  toStoredWaitlist,
  WAITLIST_STATUSES,
  type NewWaitlist,
  type StoredWaitlist,
  type WaitlistStatus,
} from '../entities/index.js';
import type { IWaitlistRepository } from '../repositories/waitlist.js';
import { waitlist as waitlistTable } from './schema.js';

/** waitlist 仓储的 Postgres 实现（全异步）。 */
export class PgWaitlistRepository implements IWaitlistRepository {
  constructor(private readonly db: PostgresJsDatabase) {}

  async insert(entry: NewWaitlist): Promise<void> {
    await this.db.insert(waitlistTable).values({
      id: entry.id,
      email: entry.email,
      name: entry.name ?? null,
      githubUsername: entry.githubUsername ?? null,
      source: entry.source ?? 'landing_page',
      status: entry.status ?? 'pending',
      notes: entry.notes ?? null,
    });
  }

  async getById(id: string): Promise<StoredWaitlist | undefined> {
    const rows = await this.db.select().from(waitlistTable).where(eq(waitlistTable.id, id)).limit(1);
    return rows[0] ? toStoredWaitlist(rows[0]) : undefined;
  }

  async getByEmail(email: string): Promise<StoredWaitlist | undefined> {
    const rows = await this.db
      .select()
      .from(waitlistTable)
      .where(eq(waitlistTable.email, email))
      .limit(1);
    return rows[0] ? toStoredWaitlist(rows[0]) : undefined;
  }

  async listByStatus(status: WaitlistStatus, limit = 100): Promise<StoredWaitlist[]> {
    const rows = await this.db
      .select()
      .from(waitlistTable)
      .where(eq(waitlistTable.status, status))
      .orderBy(desc(waitlistTable.createdAt))
      .limit(limit);
    return rows.map(toStoredWaitlist);
  }

  async listAll(limit = 200): Promise<StoredWaitlist[]> {
    const rows = await this.db
      .select()
      .from(waitlistTable)
      .orderBy(desc(waitlistTable.createdAt))
      .limit(limit);
    return rows.map(toStoredWaitlist);
  }

  async updateStatus(id: string, status: WaitlistStatus): Promise<void> {
    await this.db
      .update(waitlistTable)
      .set({ status, updatedAt: new Date().toISOString() })
      .where(eq(waitlistTable.id, id));
  }

  async updateNotes(id: string, notes: string): Promise<void> {
    await this.db
      .update(waitlistTable)
      .set({ notes, updatedAt: new Date().toISOString() })
      .where(eq(waitlistTable.id, id));
  }

  async countByStatus(): Promise<Record<WaitlistStatus, number>> {
    const rows = await this.db
      .select({ status: waitlistTable.status, count: sql<string>`count(*)` })
      .from(waitlistTable)
      .groupBy(waitlistTable.status);
    const result: Record<WaitlistStatus, number> = {
      pending: 0,
      contacted: 0,
      converted: 0,
      archived: 0,
    };
    for (const row of rows) {
      if ((WAITLIST_STATUSES as readonly string[]).includes(row.status)) {
        result[row.status as WaitlistStatus] = Number(row.count);
      }
    }
    return result;
  }
}
