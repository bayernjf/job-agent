import { desc, eq, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import {
  toStoredWaitlist,
  WAITLIST_STATUSES,
  type NewWaitlist,
  type StoredWaitlist,
  type WaitlistStatus,
} from '../entities/index.js';
import type { IWaitlistRepository } from '../repositories/waitlist.js';
import { waitlist as waitlistTable } from './schema.js';

/** waitlist 仓储的 SQLite 实现（异步接口、同步驱动）。 */
export class SqliteWaitlistRepository implements IWaitlistRepository {
  constructor(private readonly db: BetterSQLite3Database) {}

  async insert(entry: NewWaitlist): Promise<void> {
    this.db
      .insert(waitlistTable)
      .values({
        id: entry.id,
        email: entry.email,
        name: entry.name ?? null,
        githubUsername: entry.githubUsername ?? null,
        source: entry.source ?? 'landing_page',
        status: entry.status ?? 'pending',
        notes: entry.notes ?? null,
      })
      .run();
  }

  async getById(id: string): Promise<StoredWaitlist | undefined> {
    const row = this.db.select().from(waitlistTable).where(eq(waitlistTable.id, id)).get();
    return row ? toStoredWaitlist(row) : undefined;
  }

  async getByEmail(email: string): Promise<StoredWaitlist | undefined> {
    const row = this.db.select().from(waitlistTable).where(eq(waitlistTable.email, email)).get();
    return row ? toStoredWaitlist(row) : undefined;
  }

  async listByStatus(status: WaitlistStatus, limit = 100): Promise<StoredWaitlist[]> {
    const rows = this.db
      .select()
      .from(waitlistTable)
      .where(eq(waitlistTable.status, status))
      .orderBy(desc(waitlistTable.createdAt))
      .limit(limit)
      .all();
    return rows.map(toStoredWaitlist);
  }

  async listAll(limit = 200): Promise<StoredWaitlist[]> {
    const rows = this.db
      .select()
      .from(waitlistTable)
      .orderBy(desc(waitlistTable.createdAt))
      .limit(limit)
      .all();
    return rows.map(toStoredWaitlist);
  }

  async updateStatus(id: string, status: WaitlistStatus): Promise<void> {
    this.db
      .update(waitlistTable)
      .set({ status, updatedAt: new Date().toISOString() })
      .where(eq(waitlistTable.id, id))
      .run();
  }

  async updateNotes(id: string, notes: string): Promise<void> {
    this.db
      .update(waitlistTable)
      .set({ notes, updatedAt: new Date().toISOString() })
      .where(eq(waitlistTable.id, id))
      .run();
  }

  async countByStatus(): Promise<Record<WaitlistStatus, number>> {
    const rows = this.db
      .select({ status: waitlistTable.status, count: sql<number>`count(*)` })
      .from(waitlistTable)
      .groupBy(waitlistTable.status)
      .all();
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
