import { and, eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import {
  toStoredAccount,
  type ProviderIdentity,
  type StoredAccount,
} from '../entities/index.js';
import type { IAccountsRepository } from '../repositories/accounts.js';
import { accounts as t } from './schema.js';

/** accounts 仓储的 Postgres 实现（全异步）。 */
export class PgAccountsRepository implements IAccountsRepository {
  constructor(private readonly db: PostgresJsDatabase) {}

  async upsertFromProvider(input: {
    id: string;
    identity: ProviderIdentity;
  }): Promise<StoredAccount> {
    const { id, identity } = input;
    const existing = await this.db
      .select()
      .from(t)
      .where(
        and(eq(t.platform, identity.platform), eq(t.providerAccountId, identity.providerAccountId)),
      )
      .limit(1);
    const now = new Date().toISOString();

    if (existing[0]) {
      const current = existing[0]!;
      await this.db
        .update(t)
        .set({
          login: identity.login,
          name: identity.name ?? null,
          email: identity.email ?? null,
          avatarUrl: identity.avatarUrl ?? null,
          updatedAt: now,
        })
        .where(eq(t.id, current.id));
      const refreshed = await this.db.select().from(t).where(eq(t.id, current.id)).limit(1);
      return toStoredAccount(refreshed[0]!);
    }

    await this.db.insert(t).values({
      id,
      platform: identity.platform,
      providerAccountId: identity.providerAccountId,
      login: identity.login,
      name: identity.name ?? null,
      email: identity.email ?? null,
      avatarUrl: identity.avatarUrl ?? null,
      claimedProfileId: null,
    });
    const inserted = await this.db.select().from(t).where(eq(t.id, id)).limit(1);
    return toStoredAccount(inserted[0]!);
  }

  async getById(id: string): Promise<StoredAccount | undefined> {
    const rows = await this.db.select().from(t).where(eq(t.id, id)).limit(1);
    return rows[0] ? toStoredAccount(rows[0]!) : undefined;
  }

  async getByProvider(
    platform: string,
    providerAccountId: string,
  ): Promise<StoredAccount | undefined> {
    const rows = await this.db
      .select()
      .from(t)
      .where(and(eq(t.platform, platform), eq(t.providerAccountId, providerAccountId)))
      .limit(1);
    return rows[0] ? toStoredAccount(rows[0]!) : undefined;
  }

  async setClaimedProfile(
    accountId: string,
    profileId: string,
  ): Promise<StoredAccount | undefined> {
    const existing = await this.db.select().from(t).where(eq(t.id, accountId)).limit(1);
    if (!existing[0]) return undefined;
    await this.db
      .update(t)
      .set({ claimedProfileId: profileId, updatedAt: new Date().toISOString() })
      .where(eq(t.id, accountId));
    return this.getById(accountId);
  }
}
