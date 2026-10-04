import { and, eq, gt, isNull, lt, or } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import {
  toStoredExtensionAuthCode,
  type NewExtensionAuthCode,
  type StoredExtensionAuthCode,
} from '../entities/index.js';
import type { IExtensionAuthCodesRepository } from '../repositories/extension-auth-codes.js';
import { extensionAuthCodes as t } from './schema.js';

/** extension_auth_codes 仓储的 SQLite 实现。 */
export class SqliteExtensionAuthCodesRepository implements IExtensionAuthCodesRepository {
  constructor(private readonly db: BetterSQLite3Database) {}

  async create(code: NewExtensionAuthCode): Promise<void> {
    this.db
      .insert(t)
      .values({
        id: code.id,
        accountId: code.accountId,
        expiresAt: code.expiresAt,
      })
      .run();
  }

  async getById(id: string): Promise<StoredExtensionAuthCode | undefined> {
    const [row] = this.db.select().from(t).where(eq(t.id, id)).limit(1).all();
    return row ? toStoredExtensionAuthCode(row) : undefined;
  }

  async getActive(id: string, nowIso: string): Promise<StoredExtensionAuthCode | undefined> {
    const [row] = this.db
      .select()
      .from(t)
      .where(and(eq(t.id, id), isNull(t.usedAt), gt(t.expiresAt, nowIso)))
      .limit(1)
      .all();
    return row ? toStoredExtensionAuthCode(row) : undefined;
  }

  async consume(id: string, nowIso: string): Promise<boolean> {
    // 原子消费：WHERE used_at IS NULL AND expires_at > now——并发双请求只有一个成功
    const result = this.db
      .update(t)
      .set({ usedAt: nowIso })
      .where(and(eq(t.id, id), isNull(t.usedAt), gt(t.expiresAt, nowIso)))
      .run();
    return (result.changes ?? 0) > 0;
  }

  async purgeExpired(nowIso: string, retainMs: number): Promise<number> {
    const cutoff = new Date(Date.parse(nowIso) - retainMs).toISOString();
    // 删除：已消费（used_at < cutoff）或已过期（expires_at < cutoff）
    const result = this.db
      .delete(t)
      .where(or(lt(t.usedAt, cutoff), lt(t.expiresAt, cutoff)))
      .run();
    return result.changes ?? 0;
  }
}
