import { describe, expect, it } from 'vitest';
import { loadMcpConfig, hashIp, isApiKeyValid } from './config.js';
import { FixedWindowRateLimiter } from './rate-limiter.js';

describe('loadMcpConfig', () => {
  it('fail-closed defaults: no key in non-production keeps apiKey undefined (does not throw)', () => {
    const cfg = loadMcpConfig({});
    expect(cfg.apiKey).toBeUndefined();
    expect(cfg.isProduction).toBe(false);
    expect(cfg.maxRequestsPerWindow).toBe(60);
    expect(cfg.windowMs).toBe(60_000);
  });

  it('production without MCP_API_KEY throws (startup gate, never silently open)', () => {
    expect(() => loadMcpConfig({ NODE_ENV: 'production' })).toThrow(/MCP_API_KEY/);
  });

  it('production with a key loads', () => {
    const cfg = loadMcpConfig({ NODE_ENV: 'production', MCP_API_KEY: 'k' });
    expect(cfg.apiKey).toBe('k');
    expect(cfg.isProduction).toBe(true);
  });

  it('rejects invalid rate-limit env values', () => {
    expect(() => loadMcpConfig({ MCP_RATE_LIMIT_PER_WINDOW: '0' })).toThrow();
    expect(() => loadMcpConfig({ MCP_RATE_WINDOW_MS: '500' })).toThrow();
  });
});

describe('key comparison', () => {
  it('accepts exact match and rejects missing/wrong/empty', () => {
    expect(isApiKeyValid('abc', 'abc')).toBe(true);
    expect(isApiKeyValid('abd', 'abc')).toBe(false);
    expect(isApiKeyValid(undefined, 'abc')).toBe(false);
    expect(isApiKeyValid('abc', undefined)).toBe(false);
  });
});

describe('hashIp', () => {
  it('returns null for empty ip and a stable salted hash otherwise', () => {
    expect(hashIp(null, 's')).toBeNull();
    const a = hashIp('1.2.3.4', 's');
    const b = hashIp('1.2.3.4', 's');
    const c = hashIp('1.2.3.5', 's');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).not.toContain('1.2.3.4');
  });
});

describe('FixedWindowRateLimiter', () => {
  it('allows up to max then blocks within the same window, resets in next window', () => {
    let t = 1_000;
    const rl = new FixedWindowRateLimiter({ windowMs: 100, maxRequests: 2, now: () => t });
    expect(rl.tryConsume('b').allowed).toBe(true);
    expect(rl.tryConsume('b').allowed).toBe(true);
    const blocked = rl.tryConsume('b');
    expect(blocked.allowed).toBe(false);
    // 不同桶互不影响
    expect(rl.tryConsume('other').allowed).toBe(true);
    // 进入下一窗口后放行
    t += 101;
    expect(rl.tryConsume('b').allowed).toBe(true);
  });
});
