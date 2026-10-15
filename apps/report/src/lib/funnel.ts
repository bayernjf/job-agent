/**
 * 报告页 SSR 漏斗埋点（design-funnel-analytics-20261015 §5.1）。
 *
 * 种/读 ja_sid（24h HttpOnly、SameSite=Lax、Path=/）；recordView 由仓储做
 * 30 分钟 (session_ref, profile_id) 去重（刷新/翻锚点不重复计数）。
 * fail-open：任何失败只进服务端日志，绝不阻断报告页渲染。
 *
 * 隐私硬约束：只记 sessionRef/profileId/requester 三件套——不记账号 id、
 * 不记 IP、不记被分析用户名、不记 UA（schema 层就没有这些列）。
 */
import { randomUUID } from 'node:crypto';
import { FUNNEL_SESSION_COOKIE, type FunnelRequester } from '@jobagent/shared';
import { createFunnelRecorder, type FunnelRecorder } from '@jobagent/storage';
import { getWritableStorage } from './db';

/** Astro.cookies 的最小结构（页面传 Astro.cookies，测试传内存 fake） */
export interface FunnelCookies {
  get(name: string): { value: string } | undefined;
  set(name: string, value: string, options?: Record<string, unknown>): void;
}

/** ja_sid 的 Max-Age（24h，与 demo 会话 TTL 同量级；过期自然失效） */
export const FUNNEL_SESSION_MAX_AGE_S = 60 * 60 * 24;

export interface RecordReportViewInput {
  cookies: FunnelCookies;
  /** 报告画像 id（uuid 形态） */
  profileId: string;
  /** 登录 user 记 'user'，匿名/demo 记 'visitor'（判据与 canViewGated 同源） */
  requester: FunnelRequester;
  /** 测试注入 fake recorder；不传走 getWritableStorage() 装配真实 recorder */
  recorder?: FunnelRecorder;
}

export interface RecordReportViewResult {
  /** 实际使用的 ja_sid（复用或新种） */
  sessionId: string;
  /** 本次是否新种了 cookie */
  planted: boolean;
}

export async function recordReportView(
  input: RecordReportViewInput,
): Promise<RecordReportViewResult> {
  const existing = input.cookies.get(FUNNEL_SESSION_COOKIE)?.value;
  const sessionId = existing ?? randomUUID();
  const planted = !existing;
  if (planted) {
    input.cookies.set(FUNNEL_SESSION_COOKIE, sessionId, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: FUNNEL_SESSION_MAX_AGE_S,
    });
  }
  try {
    const recorder =
      input.recorder ?? createFunnelRecorder((await getWritableStorage()).funnelEvents);
    await recorder.recordView({
      event: 'report_viewed',
      sessionRef: sessionId,
      profileId: input.profileId,
      requester: input.requester,
    });
  } catch (err) {
    // recorder 内部已 fail-open；这里兜的是 getWritableStorage() 等装配失败
    console.error('[funnel] report_viewed failed:', err instanceof Error ? err.message : err);
  }
  return { sessionId, planted };
}
