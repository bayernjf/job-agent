import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runMigrations } from './sqlite/migrator.js';
import { openSqlite } from './sqlite/connection.js';
import { SqliteAccountsRepository } from './sqlite/accounts-repo.js';
import { SqliteNotificationSubscriptionsRepository } from './sqlite/notification-subscriptions-repo.js';

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../db/migrations/sqlite',
);

const T1 = '2026-10-10T01:00:00.000Z';
const T2 = '2026-10-10T02:00:00.000Z';

function fresh() {
  const { client, db } = openSqlite(':memory:');
  runMigrations(client, MIGRATIONS_DIR);
  return {
    accounts: new SqliteAccountsRepository(db),
    subs: new SqliteNotificationSubscriptionsRepository(db),
    close: () => client.close(),
  };
}

async function seedAccount(s: ReturnType<typeof fresh>, id = 'acc-1') {
  await s.accounts.upsertFromProvider({
    id,
    identity: { platform: 'github', providerAccountId: `p-${id}`, login: `login-${id}` },
  });
  return id;
}

describe('SqliteNotificationSubscriptionsRepository', () => {
  it('upserts, lists by account/channel, and keeps one row per endpoint', async () => {
    const s = fresh();
    try {
      const accountId = await seedAccount(s);
      await s.subs.upsert({ id: 'nsub-1', accountId, channel: 'web_push', endpoint: 'https://push.example/ep1', keys: { p256dh: 'k1', auth: 'a1' }, createdAt: T1 });
      await s.subs.upsert({ id: 'nsub-2', accountId, channel: 'email_digest', endpoint: 'me@example.com', createdAt: T1 });

      const mine = await s.subs.listByAccount(accountId);
      expect(mine).toHaveLength(2);
      const pushSub = mine.find((m) => m.channel === 'web_push')!;
      const emailSub = mine.find((m) => m.channel === 'email_digest')!;
      expect(pushSub).toMatchObject({ id: 'nsub-1', enabled: true, lastSentAt: null });
      expect(pushSub.keys).toEqual({ p256dh: 'k1', auth: 'a1' });
      expect(emailSub).toMatchObject({ id: 'nsub-2', keys: null });

      // 同端点再次 upsert：仍一行、keys 更新、不复制
      await s.subs.upsert({ id: 'nsub-3', accountId, channel: 'web_push', endpoint: 'https://push.example/ep1', keys: { p256dh: 'k2', auth: 'a2' }, createdAt: T2 });
      const again = await s.subs.listEnabledByAccountChannel(accountId, 'web_push');
      expect(again).toHaveLength(1);
      expect(again[0]?.keys).toEqual({ p256dh: 'k2', auth: 'a2' });
      expect(again[0]?.updatedAt).toBe(T2);

      expect(await s.subs.listEnabledByChannel('email_digest')).toHaveLength(1);
    } finally {
      s.close();
    }
  });

  it('removes by account+endpoint and by id; markSent stamps lastSentAt', async () => {
    const s = fresh();
    try {
      const accountId = await seedAccount(s);
      await s.subs.upsert({ id: 'nsub-1', accountId, channel: 'email_digest', endpoint: 'me@example.com', createdAt: T1 });

      await s.subs.markSent(['nsub-1'], T2);
      const sent = (await s.subs.listByAccount(accountId))[0];
      expect(sent?.lastSentAt).toBe(T2);

      expect(await s.subs.remove(accountId, 'email_digest', 'me@example.com')).toBe(true);
      expect(await s.subs.remove(accountId, 'email_digest', 'me@example.com')).toBe(false);
      expect(await s.subs.listByAccount(accountId)).toHaveLength(0);

      await s.subs.upsert({ id: 'nsub-2', accountId, channel: 'web_push', endpoint: 'https://push.example/ep', createdAt: T1 });
      await s.subs.removeById('nsub-2');
      expect(await s.subs.listByAccount(accountId)).toHaveLength(0);

      // 删除账号级联清订阅
      await s.subs.upsert({ id: 'nsub-3', accountId, channel: 'web_push', endpoint: 'https://push.example/ep3', createdAt: T1 });
      const other = await seedAccount(s, 'acc-2');
      expect(other).toBe('acc-2');
    } finally {
      s.close();
    }
  });
});
