/**
 * 触达通道路由（决策 #25，2026-10-10，设计见 docs/design-notification-channels-20261010.md）。
 *
 * 通知设置端点全部登录 user 态 + 本人归属闸（订阅是私有数据）：
 *   GET    /agent/notifications                 本人全部订阅（keys 不回发）
 *   PUT    /agent/notifications/email-digest    开启/关闭邮件 digest
 *   POST   /agent/notifications/web-push        upsert web push 订阅
 *   DELETE /agent/notifications/web-push        删除 web push 订阅
 *   GET    /agent/notifications/vapid-key       Web Push 应用服务器公钥
 * 内部 cron：
 *   GET  /internal/cron/digest-tick   聚合各 email_digest 订阅的新候选，产出待发 digest 列表
 *   POST /internal/cron/digest-sent   cron-worker 发送成功后回写 last_sent_at
 */
import type { Context, Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AUTH_ERROR_CODES } from '@jobagent/shared';
import { describeError } from './helpers.js';
import { WATCHDOG_STALE_THRESHOLDS } from './system.js';
import type { HonoEnv } from './types.js';
import type { RouteDeps } from './context.js';

const EmailDigestPutSchema = z
  .object({
    enabled: z.boolean(),
    email: z.string().email().max(200).optional(),
  })
  .strict();

const WebPushPostSchema = z
  .object({
    endpoint: z.string().url().max(2000),
    keys: z.object({ p256dh: z.string().min(1).max(500), auth: z.string().min(1).max(500) }).strict(),
  })
  .strict();

const WebPushDeleteSchema = z.object({ endpoint: z.string().url().max(2000) }).strict();

const DigestSentSchema = z
  .object({ subscriptionIds: z.array(z.string().min(1)).min(1).max(500) })
  .strict();

/** digest 聚合窗口缺省：从未发出过 digest 的订阅看最近 24h（UTC ms）。 */
const DIGEST_DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;

export function registerNotifications(app: Hono<HonoEnv>, d: RouteDeps): void {
  const { repos, now, cronAuthorized } = d;

  const requireUser = (
    c: Context,
  ): { accountId: string } | Response => {
    const principal = c.get('principal');
    if (principal.kind !== 'user') {
      return c.json({ error: 'authentication required', code: AUTH_ERROR_CODES.authRequired }, 401);
    }
    return principal;
  };

  // GET /agent/notifications：本人全部订阅（keys 绝不回发）
  app.get('/agent/notifications', async (c) => {
    const user = requireUser(c);
    if (user instanceof Response) return user;
    const subs = await repos.notificationSubscriptions.listByAccount(user.accountId);
    return c.json({
      subscriptions: subs.map((s) => ({
        id: s.id,
        channel: s.channel,
        endpoint: s.endpoint,
        enabled: s.enabled,
        lastSentAt: s.lastSentAt,
        createdAt: s.createdAt,
      })),
    });
  });

  // PUT /agent/notifications/email-digest：开启（upsert 目的邮箱行）或关闭（删行）
  app.put('/agent/notifications/email-digest', async (c) => {
    const user = requireUser(c);
    if (user instanceof Response) return user;
    const body = EmailDigestPutSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      return c.json({ error: 'invalid request body', details: body.error.issues }, 400);
    }
    const existing = await repos.notificationSubscriptions.listByAccount(user.accountId);
    const current = existing.find((s) => s.channel === 'email_digest');
    if (!body.data.enabled) {
      if (current) {
        await repos.notificationSubscriptions.remove(user.accountId, 'email_digest', current.endpoint);
      }
      return c.json({ ok: true, enabled: false });
    }
    let email = body.data.email ?? current?.endpoint ?? null;
    if (!email) {
      const account = await repos.accounts.getById(user.accountId);
      email = account?.email ?? null;
    }
    if (!email) {
      return c.json(
        { error: 'no email on account; provide an explicit email', code: 'EMAIL_REQUIRED' },
        400,
      );
    }
    // 换邮箱：旧行删掉再 upsert 新行（唯一键按 endpoint，留旧行会变成"两个目的地址"）
    if (current && current.endpoint !== email) {
      await repos.notificationSubscriptions.remove(user.accountId, 'email_digest', current.endpoint);
    }
    const sub = await repos.notificationSubscriptions.upsert({
      id: `nsub-${randomUUID()}`,
      accountId: user.accountId,
      channel: 'email_digest',
      endpoint: email,
      createdAt: now(),
    });
    return c.json({ ok: true, enabled: true, email: sub.endpoint, lastSentAt: sub.lastSentAt });
  });

  // POST /agent/notifications/web-push：upsert 订阅
  app.post('/agent/notifications/web-push', async (c) => {
    const user = requireUser(c);
    if (user instanceof Response) return user;
    const body = WebPushPostSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      return c.json({ error: 'invalid request body', details: body.error.issues }, 400);
    }
    const sub = await repos.notificationSubscriptions.upsert({
      id: `nsub-${randomUUID()}`,
      accountId: user.accountId,
      channel: 'web_push',
      endpoint: body.data.endpoint,
      keys: body.data.keys,
      createdAt: now(),
    });
    return c.json({ ok: true, id: sub.id });
  });

  // DELETE /agent/notifications/web-push：删订阅（不存在与不存在同形 ok，幂等）
  app.delete('/agent/notifications/web-push', async (c) => {
    const user = requireUser(c);
    if (user instanceof Response) return user;
    const body = WebPushDeleteSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      return c.json({ error: 'invalid request body', details: body.error.issues }, 400);
    }
    await repos.notificationSubscriptions.remove(user.accountId, 'web_push', body.data.endpoint);
    return c.json({ ok: true });
  });

  // GET /agent/notifications/vapid-key：应用服务器公钥（未配置如实 503）
  app.get('/agent/notifications/vapid-key', (c) => {
    const publicKey = process.env.VAPID_PUBLIC_KEY;
    if (!publicKey) {
      return c.json({ ok: false, error: 'VAPID not configured', code: 'VAPID_NOT_CONFIGURED' }, 503);
    }
    return c.json({ ok: true, publicKey });
  });

  // GET /internal/cron/digest-tick：聚合各 email_digest 订阅的新候选，产出待发 digest 列表。
  // 零候选的订阅不产信（也不回写窗口——窗口只在真正发出时推进）。
  // 系统健康兜底（deferred「Cron Worker 的失败信号没有任何读者」闭环，2026-10-10）：
  // 每日 digest 顺带携带消费心跳 stale 状态——有 pending 的信正文顶部加告警段；
  // 即使当天零候选，只要系统不健康也产一封纯告警信，保证 Web Push 没被看到时仍有
  // 每日邮件兜底（判据与 watch-heartbeat 同源：WATCHDOG_STALE_THRESHOLDS）。
  app.get('/internal/cron/digest-tick', async (c) => {
    if (!cronAuthorized(c)) return c.json({ error: 'unauthorized' }, 401);
    const started = now();
    try {
      const subs = await repos.notificationSubscriptions.listEnabledByChannel('email_digest');
      const heartbeats = await repos.cronHeartbeat.listAll();
      const staleConsumers = heartbeats
        .filter((hb) => {
          const threshold = WATCHDOG_STALE_THRESHOLDS[hb.consumer];
          if (threshold === undefined) return false;
          const lastOk = hb.lastSuccessAt ? new Date(hb.lastSuccessAt).getTime() : 0;
          return Date.now() - lastOk > threshold;
        })
        .map((hb) => `${hb.consumer} lastOk=${hb.lastSuccessAt ?? 'never'}`);
      const staleText = staleConsumers.join('; ');
      const staleBlock =
        staleConsumers.length === 0
          ? null
          : {
              text: [
                '⚠ 系统健康告警：以下 cron 消费方心跳过期（可能未部署/故障），请查 /health?deep=1：',
                `⚠ Service alert — stale consumer heartbeat: ${staleText}`,
              ].join('\n'),
              html: `<p><b>⚠ 系统健康告警 / Service alert</b><br/>${escapeHtml(staleText)}</p>`,
            };
      const digests: Array<{
        subscriptionId: string;
        to: string;
        subject: string;
        text: string;
        html: string;
      }> = [];
      for (const sub of subs) {
        const sinceIso =
          sub.lastSentAt ?? new Date(Date.parse(started) - DIGEST_DEFAULT_WINDOW_MS).toISOString();
        const intents = await repos.submitIntents.listByAccountSince(sub.accountId, sinceIso, 50);
        const pending = intents.filter((i) => i.status === 'pending');
        if (pending.length === 0) {
          // 零候选但系统不健康：仍产一封纯告警信（每日兜底，不回写窗口无妨——未发候选信）
          if (staleBlock) {
            digests.push({
              subscriptionId: sub.id,
              to: sub.endpoint,
              subject: '[JobAgent 服务告警] 消费心跳异常 / Consumer heartbeat stale',
              text: staleBlock.text,
              html: staleBlock.html,
            });
          }
          continue;
        }
        const lines = pending.map(
          (i) => `- ${i.job.title} @ ${i.job.company}（${i.matchTier}）${i.job.sourceUrl}`,
        );
        const count = pending.length;
        const subject = `[JobAgent] ${count} 个新候选待确认 / ${count} new candidate(s) awaiting approval`;
        const textBody = [
          ...(staleBlock ? [staleBlock.text, ''] : []),
          `你的求职 Agent 自 ${sinceIso} 以来扫到 ${count} 个新候选，正在工作台等你确认：`,
          `Your agent found ${count} new candidate(s) since ${sinceIso}, awaiting your approval:`,
          '',
          ...lines,
          '',
          '去工作台确认 / Open workbench: https://app.job-agent.bayjf.com/zh-CN/workbench',
          '',
          '关闭本邮件通知 / Disable: 工作台 → 通知设置 / Workbench → Notification settings',
        ].join('\n');
        const htmlBody = [
          ...(staleBlock ? [staleBlock.html, '<hr/>'] : []),
          `<p>你的求职 Agent 自 ${sinceIso} 以来扫到 <b>${count}</b> 个新候选，正在工作台等你确认。<br/>`,
          `Your agent found <b>${count}</b> new candidate(s) since ${sinceIso}, awaiting your approval.</p>`,
          '<ul>',
          ...pending.map(
            (i) =>
              `<li><a href="${escapeHtml(i.job.sourceUrl)}">${escapeHtml(i.job.title)} @ ${escapeHtml(i.job.company)}</a>（${escapeHtml(i.matchTier)}）</li>`,
          ),
          '</ul>',
          '<p><a href="https://app.job-agent.bayjf.com/zh-CN/workbench">去工作台确认 / Open workbench</a></p>',
          '<p style="color:#888;font-size:12px">关闭本邮件通知 / Disable: 工作台 → 通知设置 / Workbench → Notification settings</p>',
        ].join('\n');
        digests.push({ subscriptionId: sub.id, to: sub.endpoint, subject, text: textBody, html: htmlBody });
      }
      await repos.cronHeartbeat.recordSuccess(
        'digest-tick',
        started,
        `digests=${digests.length}${staleConsumers.length > 0 ? ` stale=${staleConsumers.length}` : ''}`,
      );
      return c.json({ ok: true, digests });
    } catch (err) {
      console.error('[cron] digest-tick failed:', JSON.stringify(describeError(err)));
      await repos.cronHeartbeat.recordFailure('digest-tick', started, (err as Error).message);
      return c.json({ ok: false, error: (err as Error).message }, 500);
    }
  });

  // POST /internal/cron/digest-sent：发送成功回写 last_sent_at（推进窗口）
  app.post('/internal/cron/digest-sent', async (c) => {
    if (!cronAuthorized(c)) return c.json({ error: 'unauthorized' }, 401);
    const body = DigestSentSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      return c.json({ error: 'invalid request body', details: body.error.issues }, 400);
    }
    await repos.notificationSubscriptions.markSent(body.data.subscriptionIds, now());
    return c.json({ ok: true });
  });
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
