import { and, desc, eq, gt, isNull, lt, or } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import {
  toStoredApiToken,
  type NewApiToken,
  type StoredApiToken,
} from '../entities/index.js';
import type { IApiTokensRepository } from '../repositories/api-tokens.js';
import { apiTokens as t } from './schema.js';

/** api_tokens 仓储的 SQLite 实现。 */
export class SqliteApiTokensRepository implements IApiTokensRepository {
  constructor(private readonly db: BetterSQLite3Database) {}

  async create(token: NewApiToken): Promise<void> {
    this.db
      .insert(t)
      .values({
        id: token.id,
        accountId: token.accountId,
        tokenHash: token.tokenHash,
        name: token.name,
        expiresAt: token.expiresAt,
      })
      .run();
  }

  async getActiveByHash(tokenHash: string, nowIso: string): Promise<StoredApiToken | undefined> {
    const [row] = this.db
      .select()
      .from(t)
      .where(
        and(eq(t.tokenHash, tokenHash), isNull(t.revokedAt), gt(t.expiresAt, nowIso)),
      )
      .limit(1)
      .all();
    return row ? toStoredApiToken(row) : undefined;
  }

  async touchAndSlide(id: string, nowIso: string, ttlMs: number): Promise<void> {
    const newExpiry = new Date(Date.parse(nowIso) + ttlMs).toISOString();
    this.db.update(t).set({ lastSeenAt: nowIso, expiresAt: newExpiry }).where(eq(t.id, id)).run();
  }

  async revoke(id: string, nowIso: string): Promise<void> {
    this.db.update(t).set({ revokedAt: nowIso }).where(eq(t.id, id)).run();
  }

  async listActiveByAccount(accountId: string, nowIso: string): Promise<StoredApiToken[]> {
    const rows = this.db
      .select()
      .from(t)
      .where(and(eq(t.accountId, accountId), isNull(t.revokedAt), gt(t.expiresAt, nowIso)))
      .orderBy(desc(t.createdAt))
      .all();
    return rows.map(toStoredApiToken);
  }

  async purgeExpired(nowIso: string, retainMs: number): Promise<number> {
    const cutoff = new Date(Date.parse(nowIso) - retainMs).toISOString();
    // 删除：已撤销且早于保留期截止，或已过期早于保留期截止
    const result = this.db
      .delete(t)
      .where(or(lt(t.revokedAt, cutoff), lt(t.expiresAt, cutoff)))
      .run();
    return result.changes ?? 0;
  }
}
