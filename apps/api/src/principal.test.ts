/** principal 边缘工具纯函数测试：Cookie 解析、身份解析降级、可信 IP、IP 哈希。 */
import { describe, expect, it } from 'vitest';
import type { Principal } from '@jobagent/shared';
import type { IDemoSessionsRepository, StoredDemoSession } from '@jobagent/storage';
import {
  DEMO_COOKIE,
  hashIp,
  pickClientIp,
  readCookie,
  resolvePrincipal,
} from './principal.js';

function fakeDemoRepo(session: StoredDemoSession | undefined): IDemoSessionsRepository {
  return {
    create: async () => {},
    getActive: async () => session,
    acquireAnalyzeSlot: async () => ({ granted: false, reason: 'not_found', used: 0 }),
    releaseAnalyzeSlot: async () => {},
    incrementMatch: async () => {},
    touch: async () => {},
    exit: async () => {},
    countRateEvents: async () => 0,
    insertRateEvent: async () => {},
    purgeExpired: async () => 0,
    purgeRateEventsBefore: async () => 0,
  };
}

const demoSession: StoredDemoSession = {
  id: 'demo-abc',
  createdAt: '2026-09-15T00:00:00.000Z',
  lastSeenAt: '2026-09-15T00:00:00.000Z',
  expiresAt: '2026-09-22T00:00:00.000Z',
  analyzeCount: 1,
  matchCount: 2,
  analyzedLogins: [],
  ipHash: null,
  status: 'active',
};

describe('readCookie', () => {
  it('parses a single cookie out of a document.cookie-style header', () => {
    const raw = 'other=1; jobagent_demo=demo-abc; foo=bar';
    expect(readCookie(raw, DEMO_COOKIE)).toBe('demo-abc');
    expect(readCookie(raw, 'missing')).toBeUndefined();
    expect(readCookie(undefined, DEMO_COOKIE)).toBeUndefined();
  });
});

describe('resolvePrincipal', () => {
  const now = () => '2026-09-15T12:00:00.000Z';

  it('is anonymous without a demo cookie', async () => {
    const p = await resolvePrincipal(undefined, fakeDemoRepo(demoSession), now);
    expect(p).toEqual({ kind: 'anonymous' });
  });

  it('silently degrades to anonymous when the session is gone/expired', async () => {
    const p = await resolvePrincipal(
      `${DEMO_COOKIE}=stale`,
      fakeDemoRepo(undefined),
      now,
    );
    expect(p).toEqual({ kind: 'anonymous' });
  });

  it('resolves a demo principal with current counters', async () => {
    const p: Principal = await resolvePrincipal(
      `${DEMO_COOKIE}=demo-abc`,
      fakeDemoRepo(demoSession),
      now,
    );
    expect(p.kind).toBe('demo');
    if (p.kind === 'demo') {
      expect(p.sessionId).toBe('demo-abc');
      expect(p.analyzeCount).toBe(1);
      expect(p.matchCount).toBe(2);
      expect(p.expiresAt).toBe('2026-09-22T00:00:00.000Z');
    }
  });
});

describe('pickClientIp', () => {
  it('trusts X-Forwarded-For first segment only when trustProxy is true', () => {
    expect(pickClientIp('1.1.1.1, 2.2.2.2', true)).toBe('1.1.1.1');
    // 不信任代理时 XFF 不可信，回退直连地址
    expect(pickClientIp('1.1.1.1', false, '10.0.0.9')).toBe('10.0.0.9');
    expect(pickClientIp(undefined, true, '10.0.0.9')).toBe('10.0.0.9');
    expect(pickClientIp(undefined, false)).toBeNull();
  });
});

describe('hashIp', () => {
  it('is deterministic for the same salt+ip and changes with salt', () => {
    const a = hashIp('1.2.3.4', 'salt');
    const b = hashIp('1.2.3.4', 'salt');
    const c = hashIp('1.2.3.4', 'other-salt');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toContain('1.2.3.4'); // 不泄露明文
  });
});
