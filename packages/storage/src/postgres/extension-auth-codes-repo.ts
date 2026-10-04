import { and, eq, isNull, lt, or } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { tsGt, tsLt } from './time-text.js';
import {
  toStoredExtensionAuthCode,
  type NewExtensionAuthCode,
  type StoredExtensionAuthCode,
} from '../entities/index.js';
import type { IExtensionAuthCodesRepository } from '../repositories/extension-auth-codes.js';
import { extensionAuthCodes as t } from './schema.js';

/** extension_auth_codes 仓储的 Postgres 实现。 */
export class PgExtensionAuthCodesRepository implements IExtensionAuthCodesRepository {
  constructor(private readonly db: PostgresJsDatabase) {}

  async create(code: NewExtensionAuthCode): Promise<void> {
    await this.db.insert(t).values({
      id: code.id,
      accountId: code.accountId,
      expiresAt: code.expiresAt,
    });
  }

  async getById(id: string): Promise<StoredExtensionAuthCode | undefined> {
    const rows = await this.db.select().from(t).where(eq(t.id, id)).limit(1);
    return rows[0] ? toStoredExtensionAuthCode(rows[0]!) : undefined;
  }

  async getActive(id: string, nowIso: string): Promise<StoredExtensionAuthCode | undefined> {
    const rows = await this.db
      .select()
      .from(t)
      .where(and(eq(t.id, id), isNull(t.usedAt), tsGt(t.expiresAt, nowIso)))
      .limit(1);
    return rows[0] ? toStoredExtensionAuthCode(rows[0]!) : undefined;
  }

  async consume(id: string, nowIso: string): Promise<boolean> {
    // 原子消费：WHERE used_at IS NULL AND expires_at > now——并发双请求只有一个成功
    const rows = await this.db
      .update(t)
      .set({ usedAt: nowIso })
      .where(and(eq(t.id, id), isNull(t.usedAt), tsGt(t.expiresAt, nowIso)))
      .returning({ id: t.id });
    return rows.length > 0;
  }

  async purgeExpired(nowIso: string, retainMs: number): Promise<number> {
    const cutoff = new Date(Date.parse(nowIso) - retainMs).toISOString();
    const rows = await this.db
      .delete(t)
      .where(or(lt(t.usedAt, cutoff), tsLt(t.expiresAt, cutoff)))
      .returning({ id: t.id });
    return rows.length;
  }
}
