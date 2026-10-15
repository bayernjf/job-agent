import { describe, expect, it, vi } from 'vitest';
import { FUNNEL_SESSION_COOKIE, type RecordFunnelInput } from '@jobagent/shared';
import { createFunnelRecorder, createStorage, type FunnelRecorder } from '@jobagent/storage';
import {
  FUNNEL_SESSION_MAX_AGE_S,
  recordReportView,
  type FunnelCookies,
} from './funnel';

/**
 * 报告页 SSR 漏斗埋点（design-funnel-analytics-20261015 §7）：
 * sid 生成/复用、30 分钟去重窗口（真 storage + 真 recorder）、fail-open。
 * 内存 SQLite，不打网络。
 */

function fakeCookies(initial?: Record<string, string>): FunnelCookies & {
  store: Map<string, string>;
  sets: Array<{ name: string; value: string; options?: Record<string, unknown> }>;
} {
  const store = new Map(Object.entries(initial ?? {}));
  const sets: Array<{ name: string; value: string; options?: Record<string, unknown> }> = [];
  return {
    store,
    sets,
    get(name) {
      const value = store.get(name);
      return value === undefined ? undefined : { value };
    },
    set(name, value, options) {
      store.set(name, value);
      sets.push({ name, value, options });
    },
  };
}

function capturingRecorder(): FunnelRecorder & {
  views: RecordFunnelInput[];
  events: RecordFunnelInput[];
} {
  const views: RecordFunnelInput[] = [];
  const events: RecordFunnelInput[] = [];
  return {
    views,
    events,
    async record(input) {
      events.push(input);
    },
    async recordView(input) {
      views.push(input);
    },
  };
}

const PROFILE_ID = '11111111-1111-4111-8111-111111111111';

describe('recordReportView', () => {
  it('无 ja_sid 时新种 24h HttpOnly cookie，并用它串联 recordView', async () => {
    const cookies = fakeCookies();
    const recorder = capturingRecorder();
    const result = await recordReportView({
      cookies,
      profileId: PROFILE_ID,
      requester: 'visitor',
      recorder,
    });
    expect(result.planted).toBe(true);
    expect(result.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(cookies.sets).toEqual([
      {
        name: FUNNEL_SESSION_COOKIE,
        value: result.sessionId,
        options: {
          httpOnly: true,
          sameSite: 'lax',
          path: '/',
          maxAge: FUNNEL_SESSION_MAX_AGE_S,
        },
      },
    ]);
    expect(recorder.views).toEqual([
      {
        event: 'report_viewed',
        sessionRef: result.sessionId,
        profileId: PROFILE_ID,
        requester: 'visitor',
      },
    ]);
  });

  it('已有 ja_sid 时复用、不重种，requester 原样透传', async () => {
    const cookies = fakeCookies({ [FUNNEL_SESSION_COOKIE]: 'sid-existing' });
    const recorder = capturingRecorder();
    const result = await recordReportView({
      cookies,
      profileId: PROFILE_ID,
      requester: 'user',
      recorder,
    });
    expect(result).toEqual({ sessionId: 'sid-existing', planted: false });
    expect(cookies.sets).toEqual([]);
    expect(recorder.views).toEqual([
      {
        event: 'report_viewed',
        sessionRef: 'sid-existing',
        profileId: PROFILE_ID,
        requester: 'user',
      },
    ]);
  });

  it('30 分钟去重窗口：真 storage + 真 recorder，同 (sid, profile) 第二次不重复计数', async () => {
    const storage = await createStorage({ sqlitePath: ':memory:' });
    const recorder = createFunnelRecorder(storage.funnelEvents);
    const cookies = fakeCookies({ [FUNNEL_SESSION_COOKIE]: 'sid-dedupe' });
    const view = {
      cookies,
      requester: 'visitor' as const,
      recorder,
    };
    await recordReportView({ ...view, profileId: PROFILE_ID });
    await recordReportView({ ...view, profileId: PROFILE_ID });
    const summary = await storage.funnelEvents.summarize({ sinceIso: '2020-01-01T00:00:00.000Z' });
    expect(summary).toEqual([
      { event: 'report_viewed', events: 1, distinctSessions: 1, nullSessions: 0 },
    ]);
    // 换 profile 属新一次查看，正常计数
    await recordReportView({ ...view, profileId: '22222222-2222-4222-8222-222222222222' });
    const after = await storage.funnelEvents.summarize({ sinceIso: '2020-01-01T00:00:00.000Z' });
    expect(after).toEqual([
      { event: 'report_viewed', events: 2, distinctSessions: 1, nullSessions: 0 },
    ]);
    await storage.close();
  });

  it('fail-open：recorder 抛错只记日志，绝不阻断渲染（仍返回 sid）', async () => {
    const cookies = fakeCookies();
    const broken: FunnelRecorder = {
      async record() {
        throw new Error('db down');
      },
      async recordView() {
        throw new Error('db down');
      },
    };
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await recordReportView({
      cookies,
      profileId: PROFILE_ID,
      requester: 'visitor',
      recorder: broken,
    });
    expect(result.planted).toBe(true);
    expect(result.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(spy).toHaveBeenCalledOnce();
    expect(String(spy.mock.calls[0]?.[1])).toContain('db down');
    spy.mockRestore();
  });
});
