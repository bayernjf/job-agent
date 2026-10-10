/**
 * notification_subscriptions 仓储契约——触达通道订阅（决策 #25）。
 *
 * 写口：通知设置 API（本人 upsert/删除）与 digest-sent 回写（last_sent_at）；
 * 读口：通知设置 API（本人列表）、agent-tick（web_push 发送）、digest-tick
 * （email_digest 聚合）。不做自动清理：行数恒等于活跃订阅数；
 * web_push 发送失败 404/410 时由发送方即时删行。
 */
import type {
  NotificationChannel,
  StoredNotificationSubscription,
} from '../entities/index.js';

export interface NewNotificationSubscription {
  id: string;
  accountId: string;
  channel: NotificationChannel;
  endpoint: string;
  keys?: { p256dh: string; auth: string } | null;
  createdAt: string;
}

export interface INotificationSubscriptionsRepository {
  /** 本人全部订阅（按 createdAt 升序） */
  listByAccount(accountId: string): Promise<StoredNotificationSubscription[]>;
  /** 某通道全部启用订阅（digest-tick / agent-tick 发送侧用） */
  listEnabledByChannel(channel: NotificationChannel): Promise<StoredNotificationSubscription[]>;
  /** 某账户某通道的启用订阅（agent-tick 对单账户发 push 用） */
  listEnabledByAccountChannel(
    accountId: string,
    channel: NotificationChannel,
  ): Promise<StoredNotificationSubscription[]>;
  /** 幂等 upsert：同 (accountId, channel, endpoint) 命中则更新 keys/enabled/updatedAt */
  upsert(sub: NewNotificationSubscription): Promise<StoredNotificationSubscription>;
  /** 删除本人某通道某端点的订阅；返回是否删到行 */
  remove(accountId: string, channel: NotificationChannel, endpoint: string): Promise<boolean>;
  /** 按 id 删除（web_push 端点失效 404/410 时发送侧即时清理） */
  removeById(id: string): Promise<void>;
  /** 成功触达回写 last_sent_at（digest-sent / push 发送成功） */
  markSent(ids: readonly string[], atIso: string): Promise<void>;
}
