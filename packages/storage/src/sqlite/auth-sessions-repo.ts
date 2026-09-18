import { and, eq, gt } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import {
  toStoredAuthSession,
  type NewAuthSession,
  type StoredAuthSession,
} from '../entities/index.js';
import type { IAuthSessionsRepository } from '../repositories/auth-sessions.js';
import { authSessions as t } from './schema.js';

/** auth_sessions 仓储的 SQLite 实现。 */
export class SqliteAuthSessionsRepository implements IAuthSessionsRepository {
  constructor(private readonly db: BetterSQLite3Database) {}

  async create(session: NewAuthSession): Promise<void> {
    this.db
      .insert(t)
      .values({
        id: session.id,
        accountId: session.accountId,
        expiresAt: session.expiresAt,
      })
      .run();
  }

  async getActive(id: string, nowIso: string): Promise<StoredAuthSession | undefined> {
    const [row] = this.db
      .select()
      .from(t)
      .where(and(eq(t.id, id), eq(t.status, 'active'), gt(t.expiresAt, nowIso)))
      .limit(1)
      .all();
    return row ? toStoredAuthSession(row) : undefined;
  }

  async touch(id: string, nowIso: string): Promise<void> {
    this.db.update(t).set({ lastSeenAt: nowIso }).where(eq(t.id, id)).run();
  }

  async revoke(id: string): Promise<void> {
    this.db.update(t).set({ status: 'revoked' }).where(eq(t.id, id)).run();
  }
}
