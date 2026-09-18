import { and, eq, gt, lt, or } from 'drizzle-orm';
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

  async purgeExpired(nowIso: string, retainMs: number): Promise<number> {
    const retainCutoff = new Date(Date.parse(nowIso) - retainMs).toISOString();
    // 删除：已撤销且最后使用早于保留期，或过期时间早于保留期截止（与 demo 清理同构）
    const result = this.db
      .delete(t)
      .where(
        or(
          and(eq(t.status, 'revoked'), lt(t.lastSeenAt, retainCutoff)),
          lt(t.expiresAt, retainCutoff),
        ),
      )
      .run();
    return result.changes ?? 0;
  }
}
