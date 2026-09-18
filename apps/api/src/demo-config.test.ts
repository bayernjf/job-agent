/** demo-config 纯函数测试：默认值、非法回退、preset/origin 解析。 */
import { describe, expect, it, vi } from 'vitest';
import { DEMO_DEFAULTS, loadDemoConfig, oneHourAgo } from './demo-config.js';

describe('loadDemoConfig', () => {
  it('falls back to documented defaults for an empty environment', () => {
    const cfg = loadDemoConfig({});
    expect(cfg.sessionTtlMs).toBe(DEMO_DEFAULTS.sessionTtlMs);
    expect(cfg.analyzeQuota).toBe(3);
    expect(cfg.fusionAnalyzeCost).toBe(2);
    expect(cfg.sessionRatePerHour).toBe(5);
    expect(cfg.analyzeRatePerHour).toBe(10);
    expect(cfg.matchRatePerHour).toBe(60);
    expect(cfg.maxConcurrent).toBe(1);
    expect(cfg.backoffMs).toBe(15_000);
    expect(cfg.ipSalt).toBe('');
    expect(cfg.presetLogins).toEqual([]);
    expect(cfg.corsAllowOrigins).toEqual([]);
    expect(cfg.trustProxy).toBe(false);
    expect(cfg.isProduction).toBe(false);
  });

  it('parses valid overrides', () => {
    const cfg = loadDemoConfig({
      DEMO_ANALYZE_QUOTA: '7',
      DEMO_FUSION_QUOTA_COST: '3',
      TRUST_PROXY: 'true',
      NODE_ENV: 'production',
      DEMO_IP_SALT: 'salt-x',
      DEMO_PRESET_LOGINS: 'github:alice, gitee:bob ,github:alice',
      CORS_ALLOW_ORIGINS: 'https://a.example.com, https://b.example.com ',
    });
    expect(cfg.analyzeQuota).toBe(7);
    expect(cfg.fusionAnalyzeCost).toBe(3);
    expect(cfg.trustProxy).toBe(true);
    expect(cfg.isProduction).toBe(true);
    expect(cfg.ipSalt).toBe('salt-x');
    expect(cfg.presetLogins).toEqual([
      { platform: 'github', login: 'alice' },
      { platform: 'gitee', login: 'bob' },
      { platform: 'github', login: 'alice' },
    ]);
    expect(cfg.corsAllowOrigins).toEqual(['https://a.example.com', 'https://b.example.com']);
  });

  it('falls back to default and warns on invalid integers', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cfg = loadDemoConfig({
      DEMO_ANALYZE_QUOTA: 'not-a-number',
      DEMO_MAX_CONCURRENT: '-3',
      DEMO_FUSION_QUOTA_COST: '0', // 权重最小为 1，0 非法
    });
    expect(cfg.analyzeQuota).toBe(DEMO_DEFAULTS.analyzeQuota);
    expect(cfg.maxConcurrent).toBe(DEMO_DEFAULTS.maxConcurrent);
    expect(cfg.fusionAnalyzeCost).toBe(DEMO_DEFAULTS.fusionAnalyzeCost);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('ignores malformed preset entries', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cfg = loadDemoConfig({
      DEMO_PRESET_LOGINS: 'github:ok, gitlab:bad, noSeparator, :emptylogin',
    });
    expect(cfg.presetLogins).toEqual([{ platform: 'github', login: 'ok' }]);
    warn.mockRestore();
  });

  it('computes a one-hour-ago ISO timestamp', () => {
    expect(oneHourAgo('2026-09-15T12:00:00.000Z')).toBe('2026-09-15T11:00:00.000Z');
  });
});
