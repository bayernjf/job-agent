import { describe, expect, it } from 'vitest';
import { resolveBrowserApiBase } from './api-base';

/**
 * 浏览器侧 API 基址解析（形态 C 关键契约）：
 * 1. PUBLIC_API_BASE 显式配置最优先（本地/Docker 跨端口、跨域形态）；
 * 2. Vercel 同域部署时回落到同域 /api；
 * 3. 其余情况返回空串（同源相对路径）。
 * 注：PUBLIC_* 经 Vite 静态替换、vi.stubEnv 改不到，故直接测可注入的纯函数。
 */
describe('resolveBrowserApiBase', () => {
  it('returns the explicit PUBLIC_API_BASE when configured, even on Vercel', () => {
    expect(
      resolveBrowserApiBase({ publicApiBase: 'https://api.example.com', vercel: '1' }),
    ).toBe('https://api.example.com');
  });

  it('trims whitespace from an explicit base', () => {
    expect(resolveBrowserApiBase({ publicApiBase: '  http://localhost:3000  ' })).toBe(
      'http://localhost:3000',
    );
  });

  it('falls back to same-origin /api on Vercel when no explicit base', () => {
    expect(resolveBrowserApiBase({ publicApiBase: '', vercel: '1' })).toBe('/api');
    expect(resolveBrowserApiBase({ publicApiBase: '   ', vercel: '1' })).toBe('/api');
    expect(resolveBrowserApiBase({ publicApiBase: undefined, vercel: '1' })).toBe('/api');
  });

  it('returns an empty relative base outside Vercel without explicit config', () => {
    expect(resolveBrowserApiBase({ publicApiBase: '', vercel: '' })).toBe('');
    expect(resolveBrowserApiBase({ publicApiBase: undefined, vercel: undefined })).toBe('');
  });
});
