/**
 * 验证漏斗客户端事件端点（design-funnel-analytics-20261015 §5.3）。
 *
 * 只接受白名单事件 share_clicked（其余三类是服务端事件，伪造一律 400）；
 * 复用 demo IP 滑窗表限流（bucket 'funnel'，每可信 IP 60 次/小时，无迁移）；
 * 响应层 fail-open：埋点写入失败绝不暴露给前端（recorder 内部已吞错），成功/失败都 202。
 */
import type { Hono } from 'hono';
import {
  FUNNEL_SESSION_COOKIE,
  RecordClientFunnelEventSchema,
} from '@jobagent/shared';
import { oneHourAgo } from '../demo-config.js';
import { readCookie } from '../principal.js';
import type { HonoEnv } from './types.js';
import type { RouteDeps } from './context.js';

/** 每可信 IP 每小时允许上报的漏斗事件上限（代码常量，不加 env） */
const FUNNEL_RATE_PER_HOUR = 60;

export function registerFunnel(app: Hono<HonoEnv>, d: RouteDeps): void {
  app.post('/funnel/events', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    // 白名单之外的 event（含伪造的服务端三类）都在这里 400
    const parsed = RecordClientFunnelEventSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'validation failed', details: parsed.error.flatten() }, 400);
    }

    // IP 滑窗限流（无可信 IP 不拦，端点只写一条事件 + 30 分钟会话去重兜底）
    const ipHash = d.ipHashOf(c);
    const nowIso = d.now();
    if (ipHash) {
      const recent = await d.repos.demoSessions.countRateEvents(
        ipHash,
        'funnel',
        oneHourAgo(nowIso),
      );
      if (recent >= FUNNEL_RATE_PER_HOUR) {
        return c.json({ error: 'funnel event rate limit exceeded', retryAfterSeconds: 3600 }, 429);
      }
      await d.repos.demoSessions.insertRateEvent(ipHash, 'funnel', nowIso);
    }

    await d.funnelRecorder.record({
      event: parsed.data.event,
      sessionRef: readCookie(c.req.header('cookie'), FUNNEL_SESSION_COOKIE) ?? null,
      profileId: parsed.data.profileId ?? null,
      requester: null,
    });
    // 202 Accepted：上报语义，永不把埋点内部错误暴露给前端
    return c.body(null, 202);
  });
}
