/**
 * Web Push 发送薄壳（决策 #25-2，设计见 docs/design-notification-channels-20261010.md §5/§6）。
 *
 * agent-tick 一轮内某 run 进入 awaiting_approval（有新 pending 候选）后调用；
 * 发送失败绝不抛出、绝不阻塞 tick 主流程——返回结果由调用方记日志；
 * 404/410 的端点已失效，调用方负责即时删订阅行。
 */
import webpush from 'web-push';

export interface PushPayload {
  title: string;
  body: string;
  /** notificationclick 打开/聚焦的深链 */
  url: string;
}

export interface PushSendResult {
  subscriptionId: string;
  ok: boolean;
  /** 端点已失效（404/410），调用方应删行 */
  gone: boolean;
  error?: string;
}

let vapidReady = false;

/** 惰性配置 VAPID；未配置返回 false（调用方跳过发送、不算失败）。 */
function ensureVapid(): boolean {
  if (vapidReady) return true;
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  if (!publicKey || !privateKey) return false;
  webpush.setVapidDetails('mailto:job-agent@bayjf.com', publicKey, privateKey);
  vapidReady = true;
  return true;
}

export async function sendWebPush(
  subs: ReadonlyArray<{ id: string; endpoint: string; keys: { p256dh: string; auth: string } | null }>,
  payload: PushPayload,
): Promise<PushSendResult[]> {
  if (!ensureVapid()) return [];
  const body = JSON.stringify(payload);
  const results: PushSendResult[] = [];
  for (const sub of subs) {
    if (!sub.keys) {
      results.push({ subscriptionId: sub.id, ok: false, gone: true, error: 'missing keys' });
      continue;
    }
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: sub.keys },
        body,
        { TTL: 3600 },
      );
      results.push({ subscriptionId: sub.id, ok: true, gone: false });
    } catch (err) {
      const statusCode = (err as { statusCode?: number }).statusCode;
      results.push({
        subscriptionId: sub.id,
        ok: false,
        gone: statusCode === 404 || statusCode === 410,
        error: (err as Error).message,
      });
    }
  }
  return results;
}
