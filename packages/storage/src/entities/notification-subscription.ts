/**
 * notification_subscriptions 实体：触达通道订阅（决策 #25，2026-10-10，
 * 设计见 docs/design-notification-channels-20261010.md）。
 *
 * 一行 = 一个账户在一个通道上的一个订阅端点；行的存在性就是 opt-in
 * （关闭＝删行，不留"沉默订阅"）。
 * - channel='email_digest'：endpoint 为目的邮箱地址，keys_json 恒 NULL，
 *   last_sent_at 支撑"距上次 digest 后新增候选"窗口；
 * - channel='web_push'：endpoint 为 push endpoint URL，keys_json 为
 *   {p256dh, auth}，last_sent_at 仅作观测（每次匹配即推、无窗口）。
 */
export type NotificationChannel = 'email_digest' | 'web_push';

export interface StoredNotificationSubscription {
  /** 内部稳定 id：nsub-<uuid> */
  id: string;
  accountId: string;
  channel: NotificationChannel;
  /** web_push＝push endpoint URL；email_digest＝目的邮箱地址 */
  endpoint: string;
  /** web_push 的 {p256dh, auth}；email_digest 恒 null */
  keys: { p256dh: string; auth: string } | null;
  enabled: boolean;
  /** 上次成功触达时刻（UTC ISO8601）；从未触达为 null */
  lastSentAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Drizzle 查询返回的原始行（camelCase），两方言结构一致 */
export interface RawNotificationSubscriptionRow {
  id: string;
  accountId: string;
  channel: string;
  endpoint: string;
  keysJson: string | null;
  enabled: number;
  lastSentAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export function toStoredNotificationSubscription(
  row: RawNotificationSubscriptionRow,
): StoredNotificationSubscription {
  let keys: StoredNotificationSubscription['keys'] = null;
  if (row.keysJson) {
    try {
      const parsed = JSON.parse(row.keysJson) as { p256dh?: unknown; auth?: unknown };
      if (typeof parsed.p256dh === 'string' && typeof parsed.auth === 'string') {
        keys = { p256dh: parsed.p256dh, auth: parsed.auth };
      }
    } catch {
      keys = null;
    }
  }
  return {
    id: row.id,
    accountId: row.accountId,
    channel: row.channel === 'web_push' ? 'web_push' : 'email_digest',
    endpoint: row.endpoint,
    keys,
    enabled: row.enabled !== 0,
    lastSentAt: row.lastSentAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
