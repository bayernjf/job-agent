/**
 * 演示模式路由（Q1 单文件拆分）：免注册会话 + 配额 + 预置账号。
 * 必须在 analyze 路由之前注册。
 */
import type { Hono } from 'hono';
import { setCookie, deleteCookie } from 'hono/cookie';
import {
  DEMO_ERROR_CODES,
  type AbilityProfile,
  type DemoMe,
  type DemoPreset,
} from '@jobagent/shared';
import { oneHourAgo } from '../demo-config.js';
import { DEMO_COOKIE, generateSessionId } from '../principal.js';
import { demoCookieOptions, toDemoMe } from './helpers.js';
import type { HonoEnv } from './types.js';
import type { RouteDeps } from './context.js';

export function registerDemo(app: Hono<HonoEnv>, d: RouteDeps): void {
  const { repos, now, cfg, ipHashOf } = d;

  // POST /demo/sessions：免注册创建（或幂等返回）演示会话
  app.post('/demo/sessions', async (c) => {
    const principal = c.get('principal');
    const nowIso = now();
    if (principal.kind === 'demo') {
      return c.json(toDemoMe(principal, cfg.analyzeQuota), 200); // 幂等，不重复建/不占窗口
    }

    const ipHash = ipHashOf(c);
    if (ipHash) {
      const recent = await repos.demoSessions.countRateEvents(
        ipHash,
        'session',
        oneHourAgo(nowIso),
      );
      if (recent >= cfg.sessionRatePerHour) {
        return c.json(
          {
            error: 'demo session rate limit exceeded',
            code: DEMO_ERROR_CODES.rateLimited,
            bucket: 'session',
            retryAfterSeconds: 3600,
          },
          429,
        );
      }
    }

    const id = generateSessionId();
    const expiresAt = new Date(Date.parse(nowIso) + cfg.sessionTtlMs).toISOString();
    await repos.demoSessions.create({ id, expiresAt, ipHash });
    if (ipHash) await repos.demoSessions.insertRateEvent(ipHash, 'session', nowIso);
    setCookie(c, DEMO_COOKIE, id, demoCookieOptions(cfg, nowIso));

    return c.json(
      {
        kind: 'demo',
        sessionId: id,
        expiresAt,
        analyzeQuota: cfg.analyzeQuota,
        analyzeUsed: 0,
        analyzeRemaining: cfg.analyzeQuota,
      } satisfies DemoMe,
      201,
    );
  });

  // GET /demo/me：当前演示身份与配额状态
  app.get('/demo/me', (c) => {
    return c.json(toDemoMe(c.get('principal'), cfg.analyzeQuota));
  });

  // GET /demo/presets：预置示例账号的就绪情况（只读、公开）
  app.get('/demo/presets', async (c) => {
    const presets: DemoPreset[] = [];
    for (const preset of cfg.presetLogins) {
      const profile = await repos.profiles.latestBySubject(preset.platform, preset.login);
      const ready = !!profile && profile.status === 'complete' && !!profile.snapshot;
      const authenticity = ready
        ? ((profile!.snapshot as AbilityProfile).authenticity?.status ?? 'unknown')
        : 'unknown';
      presets.push({
        platform: preset.platform,
        login: preset.login,
        authenticity,
        profileId: ready ? profile!.id : null,
        ready,
      });
    }
    return c.json(presets);
  });

  // POST /demo/exit：退出演示（匿名调用为 no-op）
  app.post('/demo/exit', async (c) => {
    const principal = c.get('principal');
    if (principal.kind === 'demo') {
      await repos.demoSessions.exit(principal.sessionId, now());
    }
    deleteCookie(c, DEMO_COOKIE, { path: '/' });
    return c.json({ kind: 'anonymous' });
  });
}
