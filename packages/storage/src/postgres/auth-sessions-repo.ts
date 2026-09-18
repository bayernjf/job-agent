import { and, eq, gt, lt, or } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import {
  toStoredAuthSession,
  type NewAuthSession,
  type StoredAuthSession,
} from '../entities/index.js';
import type { IAuthSessionsRepository } from '../repositories/auth-sessions.js';
import { authSessions as t } from './schema.js';

/** auth_sessions 仓储的 Postgres 实现。 */
export class PgAuthSessionsRepository implements IAuthSessionsRepository {
  constructor(private readonly db: PostgresJsDatabase) {}

  async create(session: NewAuthSession): Promise<void> {
    await this.db.insert(t).values({
      id: session.id,
      accountId: session.accountId,
      expiresAt: session.expiresAt,
    });
  }

  async getActive(id: string, nowIso: string): Promise<StoredAuthSession | undefined> {
    const rows = await this.db
      .select()
      .from(t)
      .where(and(eq(t.id, id), eq(t.status, 'active'), gt(t.expiresAt, nowIso)))
      .limit(1);
    return rows[0] ? toStoredAuthSession(rows[0]!) : undefined;
  }

  async touch(id: string, nowIso: string): Promise<void> {
    await this.db.update(t).set({ lastSeenAt: nowIso }).where(eq(t.id, id));
  }

  async revoke(id: string): Promise<void> {
    await this.db.update(t).set({ status: 'revoked' }).where(eq(t.id, id));
  }

  async purgeExpired(nowIso: string, retainMs: number): Promise<number> {
    const retainCutoff = new Date(Date.parse(nowIso) - retainMs).toISOString();
    // 删除：已撤销且最后使用早于保留期，或过期时间早于保留期截止（与 demo 清理同构）
    const rows = await this.db
      .delete(t)
      .where(
        or(
          and(eq(t.status, 'revoked'), lt(t.lastSeenAt, retainCutoff)),
          lt(t.expiresAt, retainCutoff),
        ),
      )
      .returning({ id: t.id });
    return rows.length;
  }
}
