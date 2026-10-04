import { and, desc, eq, isNull, lt, or } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { tsGt, tsLt } from './time-text.js';
import {
  toStoredApiToken,
  type NewApiToken,
  type StoredApiToken,
} from '../entities/index.js';
import type { IApiTokensRepository } from '../repositories/api-tokens.js';
import { apiTokens as t } from './schema.js';

/** api_tokens 仓储的 Postgres 实现。 */
export class PgApiTokensRepository implements IApiTokensRepository {
  constructor(private readonly db: PostgresJsDatabase) {}

  async create(token: NewApiToken): Promise<void> {
    await this.db.insert(t).values({
      id: token.id,
      accountId: token.accountId,
      tokenHash: token.tokenHash,
      name: token.name,
      expiresAt: token.expiresAt,
    });
  }

  async getActiveByHash(tokenHash: string, nowIso: string): Promise<StoredApiToken | undefined> {
    const rows = await this.db
      .select()
      .from(t)
      .where(and(eq(t.tokenHash, tokenHash), isNull(t.revokedAt), tsGt(t.expiresAt, nowIso)))
      .limit(1);
    return rows[0] ? toStoredApiToken(rows[0]!) : undefined;
  }

  async touchAndSlide(id: string, nowIso: string, ttlMs: number): Promise<void> {
    const newExpiry = new Date(Date.parse(nowIso) + ttlMs).toISOString();
    await this.db.update(t).set({ lastSeenAt: nowIso, expiresAt: newExpiry }).where(eq(t.id, id));
  }

  async revoke(id: string, nowIso: string): Promise<void> {
    await this.db.update(t).set({ revokedAt: nowIso }).where(eq(t.id, id));
  }

  async listActiveByAccount(accountId: string, nowIso: string): Promise<StoredApiToken[]> {
    const rows = await this.db
      .select()
      .from(t)
      .where(and(eq(t.accountId, accountId), isNull(t.revokedAt), tsGt(t.expiresAt, nowIso)))
      .orderBy(desc(t.createdAt));
    return rows.map(toStoredApiToken);
  }

  async purgeExpired(nowIso: string, retainMs: number): Promise<number> {
    const cutoff = new Date(Date.parse(nowIso) - retainMs).toISOString();
    const rows = await this.db
      .delete(t)
      .where(or(lt(t.revokedAt, cutoff), tsLt(t.expiresAt, cutoff)))
      .returning({ id: t.id });
    return rows.length;
  }
}
