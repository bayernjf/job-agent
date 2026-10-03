import { and, eq, isNull, lt, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import {
  toStoredAccount,
  type ProviderIdentity,
  type StoredAccount,
} from '../entities/index.js';
import type { IAccountsRepository } from '../repositories/accounts.js';
import { accounts as t } from './schema.js';

/** accounts 仓储的 SQLite 实现（Drizzle better-sqlite3 同步驱动，接口异步）。 */
export class SqliteAccountsRepository implements IAccountsRepository {
  constructor(private readonly db: BetterSQLite3Database) {}

  async upsertFromProvider(input: {
    id: string;
    identity: ProviderIdentity;
  }): Promise<StoredAccount> {
    const { id, identity } = input;
    const existing = this.db
      .select()
      .from(t)
      .where(
        and(eq(t.platform, identity.platform), eq(t.providerAccountId, identity.providerAccountId)),
      )
      .limit(1)
      .all();
    const now = new Date().toISOString();

    if (existing[0]) {
      const current = existing[0]!;
      this.db
        .update(t)
        .set({
          login: identity.login,
          name: identity.name ?? null,
          email: identity.email ?? null,
          avatarUrl: identity.avatarUrl ?? null,
          updatedAt: now,
        })
        .where(eq(t.id, current.id))
        .run();
      const [refreshed] = this.db.select().from(t).where(eq(t.id, current.id)).limit(1).all();
      return toStoredAccount(refreshed!);
    }

    this.db
      .insert(t)
      .values({
        id,
        platform: identity.platform,
        providerAccountId: identity.providerAccountId,
        login: identity.login,
        name: identity.name ?? null,
        email: identity.email ?? null,
        avatarUrl: identity.avatarUrl ?? null,
        claimedProfileId: null,
      })
      .run();
    const [inserted] = this.db.select().from(t).where(eq(t.id, id)).limit(1).all();
    return toStoredAccount(inserted!);
  }

  async getById(id: string): Promise<StoredAccount | undefined> {
    const [row] = this.db.select().from(t).where(eq(t.id, id)).limit(1).all();
    return row ? toStoredAccount(row) : undefined;
  }

  async getByProvider(
    platform: string,
    providerAccountId: string,
  ): Promise<StoredAccount | undefined> {
    const [row] = this.db
      .select()
      .from(t)
      .where(and(eq(t.platform, platform), eq(t.providerAccountId, providerAccountId)))
      .limit(1)
      .all();
    return row ? toStoredAccount(row) : undefined;
  }

  async setClaimedProfile(accountId: string, profileId: string): Promise<StoredAccount | undefined> {
    const existing = await this.getById(accountId);
    if (!existing) return undefined;
    this.db
      .update(t)
      .set({ claimedProfileId: profileId, updatedAt: new Date().toISOString() })
      .where(eq(t.id, accountId))
      .run();
    return this.getById(accountId);
  }

  async clearClaimedProfile(accountId: string): Promise<StoredAccount | undefined> {
    const existing = await this.getById(accountId);
    if (!existing) return undefined;
    this.db
      .update(t)
      .set({ claimedProfileId: null, updatedAt: new Date().toISOString() })
      .where(eq(t.id, accountId))
      .run();
    return this.getById(accountId);
  }

  async clearClaimedProfileByProfileId(profileId: string): Promise<number> {
    const result = this.db
      .update(t)
      .set({ claimedProfileId: null, updatedAt: new Date().toISOString() })
      .where(eq(t.claimedProfileId, profileId))
      .run();
    return result.changes ?? 0;
  }

  async declareRecruiter(
    accountId: string,
    nowIso: string,
  ): Promise<StoredAccount | undefined> {
    const existing = await this.getById(accountId);
    if (!existing) return undefined;
    // 幂等：已声明则保留原时刻，仅在未声明时写入。
    if (existing.recruiterDeclaredAt) return existing;
    this.db
      .update(t)
      .set({ recruiterDeclaredAt: nowIso, updatedAt: nowIso })
      .where(eq(t.id, accountId))
      .run();
    return this.getById(accountId);
  }

  async revokeRecruiter(accountId: string): Promise<StoredAccount | undefined> {
    const existing = await this.getById(accountId);
    if (!existing) return undefined;
    const now = new Date().toISOString();
    this.db
      .update(t)
      // 撤声明不动 updatedAt 的清理语义风险：仍更新时间戳，与其他写操作一致。
      .set({ recruiterDeclaredAt: null, updatedAt: now })
      .where(eq(t.id, accountId))
      .run();
    return this.getById(accountId);
  }

  async deleteUnclaimed(nowIso: string, retainMs: number): Promise<number> {
    const retainCutoff = new Date(Date.parse(nowIso) - retainMs).toISOString();
    // 仅删：从未认领、超过保留期未更新、当前没有未过期会话、且从未声明招聘方
    // 的账号（F10 §7.1：声明账号永不被后台清理，避免权限被静默收回）。
    // 物理表/列名 sqlite 与 postgres 一致（snake_case），故此 NOT EXISTS 子句双方言通用。
    const result = this.db
      .delete(t)
      .where(
        and(
          isNull(t.claimedProfileId),
          isNull(t.recruiterDeclaredAt),
          lt(t.updatedAt, retainCutoff),
          sql`not exists (select 1 from auth_sessions where auth_sessions.account_id = ${t.id} and auth_sessions.expires_at >= ${nowIso})`,
        ),
      )
      .run();
    return result.changes ?? 0;
  }

  async setAdmin(accountId: string, isAdmin: boolean): Promise<StoredAccount | undefined> {
    const result = this.db
      .update(t)
      .set({ isAdmin: isAdmin ? 1 : 0, updatedAt: new Date().toISOString() })
      .where(eq(t.id, accountId))
      .run();
    if ((result.changes ?? 0) === 0) return undefined;
    return this.getById(accountId);
  }
}
