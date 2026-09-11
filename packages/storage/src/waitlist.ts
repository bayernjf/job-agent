import { desc, eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { waitlist as waitlistTable, type WaitlistSelect } from './schema.js';

/**
 * waitlist 仓储——落地页留资的唯一数据访问入口。
 * email 唯一去重，状态机：pending -> contacted -> converted | archived。
 */

export type WaitlistStatus = 'pending' | 'contacted' | 'converted' | 'archived';
export type WaitlistSource = 'landing_page' | 'api' | 'referral';

export const WAITLIST_STATUSES: readonly WaitlistStatus[] = ['pending', 'contacted', 'converted', 'archived'];

export interface StoredWaitlist {
  id: string;
  email: string;
  name: string | null;
  githubUsername: string | null;
  source: string;
  status: WaitlistStatus;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NewWaitlist {
  id: string;
  email: string;
  name?: string;
  githubUsername?: string;
  source?: WaitlistSource;
  status?: WaitlistStatus;
  notes?: string;
}

function toStoredWaitlist(row: WaitlistSelect): StoredWaitlist {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    githubUsername: row.githubUsername,
    source: row.source,
    status: (WAITLIST_STATUSES as readonly string[]).includes(row.status)
      ? (row.status as WaitlistStatus)
      : 'pending',
    notes: row.notes,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class WaitlistRepository {
  constructor(private readonly db: BetterSQLite3Database) {}

  /** 新增留资（email 唯一，重复会抛 SQLite 约束错误） */
  insert(entry: NewWaitlist): void {
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

  /** 按 ID 查询 */
  getById(id: string): StoredWaitlist | undefined {
    const row = this.db.select().from(waitlistTable).where(eq(waitlistTable.id, id)).get();
    return row ? toStoredWaitlist(row) : undefined;
  }

  /** 按 email 查询（去重检查） */
  getByEmail(email: string): StoredWaitlist | undefined {
    const row = this.db.select().from(waitlistTable).where(eq(waitlistTable.email, email)).get();
    return row ? toStoredWaitlist(row) : undefined;
  }

  /** 按状态查询（CRM 工作流） */
  listByStatus(status: WaitlistStatus, limit = 100): StoredWaitlist[] {
    const rows = this.db
      .select()
      .from(waitlistTable)
      .where(eq(waitlistTable.status, status))
      .orderBy(desc(waitlistTable.createdAt))
      .limit(limit)
      .all();
    return rows.map(toStoredWaitlist);
  }

  /** 列出全部（按创建时间倒序） */
  listAll(limit = 200): StoredWaitlist[] {
    const rows = this.db
      .select()
      .from(waitlistTable)
      .orderBy(desc(waitlistTable.createdAt))
      .limit(limit)
      .all();
    return rows.map(toStoredWaitlist);
  }

  /** 更新状态 */
  updateStatus(id: string, status: WaitlistStatus): void {
    this.db
      .update(waitlistTable)
      .set({ status, updatedAt: new Date().toISOString() })
      .where(eq(waitlistTable.id, id))
      .run();
  }

  /** 更新备注 */
  updateNotes(id: string, notes: string): void {
    this.db
      .update(waitlistTable)
      .set({ notes, updatedAt: new Date().toISOString() })
      .where(eq(waitlistTable.id, id))
      .run();
  }

  /** 统计各状态数量 */
  countByStatus(): Record<WaitlistStatus, number> {
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

import { sql } from 'drizzle-orm';
