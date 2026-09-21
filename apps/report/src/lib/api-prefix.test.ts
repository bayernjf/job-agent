import { describe, expect, it } from 'vitest';
import { stripApiPrefix } from './api-prefix';

/**
 * 形态 C 同域挂载：/api/* catch-all 转发到 Hono 前的前缀剥离契约。
 * Hono 路由不含 /api 前缀，剥错会让所有同域 API 404（曾是真实缺陷面）。
 */
describe('stripApiPrefix', () => {
  it('strips the bare /api prefix to root', () => {
    expect(stripApiPrefix('/api')).toBe('/');
    expect(stripApiPrefix('/api/')).toBe('/');
  });

  it('strips the prefix while keeping the rest of the path', () => {
    expect(stripApiPrefix('/api/health')).toBe('/health');
    expect(stripApiPrefix('/api/analyze')).toBe('/analyze');
    expect(stripApiPrefix('/api/auth/github/callback')).toBe('/auth/github/callback');
    expect(stripApiPrefix('/api/internal/cron/process-job')).toBe('/internal/cron/process-job');
  });

  it('leaves query-less paths without the prefix untouched', () => {
    expect(stripApiPrefix('/health')).toBe('/health');
    expect(stripApiPrefix('/')).toBe('/');
  });

  it('does not strip lookalike prefixes such as /api-docs', () => {
    // 正则要求 /api 后是斜杠或结尾，/api-docs 不是 API 挂载点
    expect(stripApiPrefix('/api-docs')).toBe('/api-docs');
  });
});
