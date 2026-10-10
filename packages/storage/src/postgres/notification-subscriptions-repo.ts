import { and, asc, eq, inArray } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import {
  toStoredNotificationSubscription,
  type NotificationChannel,
  type StoredNotificationSubscription,
} from '../entities/index.js';
import type {
  INotificationSubscriptionsRepository,
  NewNotificationSubscription,
} from '../repositories/notification-subscriptions.js';
import { notificationSubscriptions as t } from './schema.js';

/** notification_subscriptions 仓储的 Postgres 实现。 */
export class PgNotificationSubscriptionsRepository
  implements INotificationSubscriptionsRepository
{
  constructor(private readonly db: PostgresJsDatabase) {}

  async listByAccount(accountId: string): Promise<StoredNotificationSubscription[]> {
    const rows = await this.db
      .select()
      .from(t)
      .where(eq(t.accountId, accountId))
      .orderBy(asc(t.createdAt));
    return rows.map(toStoredNotificationSubscription);
  }

  async listEnabledByChannel(channel: NotificationChannel): Promise<StoredNotificationSubscription[]> {
    const rows = await this.db
      .select()
      .from(t)
      .where(and(eq(t.channel, channel), eq(t.enabled, 1)))
      .orderBy(asc(t.createdAt));
    return rows.map(toStoredNotificationSubscription);
  }

  async listEnabledByAccountChannel(
    accountId: string,
    channel: NotificationChannel,
  ): Promise<StoredNotificationSubscription[]> {
    const rows = await this.db
      .select()
      .from(t)
      .where(and(eq(t.accountId, accountId), eq(t.channel, channel), eq(t.enabled, 1)))
      .orderBy(asc(t.createdAt));
    return rows.map(toStoredNotificationSubscription);
  }

  async upsert(sub: NewNotificationSubscription): Promise<StoredNotificationSubscription> {
    const keysJson = sub.keys ? JSON.stringify(sub.keys) : null;
    await this.db
      .insert(t)
      .values({
        id: sub.id,
        accountId: sub.accountId,
        channel: sub.channel,
        endpoint: sub.endpoint,
        keysJson,
        enabled: 1,
        createdAt: sub.createdAt,
        updatedAt: sub.createdAt,
      })
      .onConflictDoUpdate({
        target: [t.accountId, t.channel, t.endpoint],
        set: { keysJson, enabled: 1, updatedAt: sub.createdAt },
      });
    const rows = await this.db
      .select()
      .from(t)
      .where(and(eq(t.accountId, sub.accountId), eq(t.channel, sub.channel), eq(t.endpoint, sub.endpoint)));
    const row = rows[0];
    if (!row) throw new Error('notification subscription upsert failed');
    return toStoredNotificationSubscription(row);
  }

  async remove(accountId: string, channel: NotificationChannel, endpoint: string): Promise<boolean> {
    const res = await this.db
      .delete(t)
      .where(and(eq(t.accountId, accountId), eq(t.channel, channel), eq(t.endpoint, endpoint)));
    return (res.count ?? 0) > 0;
  }

  async removeById(id: string): Promise<void> {
    await this.db.delete(t).where(eq(t.id, id));
  }

  async markSent(ids: readonly string[], atIso: string): Promise<void> {
    if (ids.length === 0) return;
    await this.db.update(t).set({ lastSentAt: atIso, updatedAt: atIso }).where(inArray(t.id, [...ids]));
  }
}
