import { describe, expect, it } from 'vitest';
import { MAX_RETURN_TO_LENGTH, sanitizeReturnTo } from './auth-return-to.js';

describe('sanitizeReturnTo', () => {
  it('accepts same-origin absolute paths, keeping query and hash verbatim', () => {
    expect(sanitizeReturnTo('/zh-CN/report/prof_1?view=recruiter')).toBe(
      '/zh-CN/report/prof_1?view=recruiter',
    );
    expect(sanitizeReturnTo('/en/report/prof_1#interview')).toBe('/en/report/prof_1#interview');
    expect(sanitizeReturnTo('/')).toBe('/');
    expect(sanitizeReturnTo('/recruit?skills=typescript')).toBe('/recruit?skills=typescript');
  });

  it('trims surrounding whitespace', () => {
    expect(sanitizeReturnTo('  /en/report/x  ')).toBe('/en/report/x');
  });

  it('rejects empty / missing values', () => {
    expect(sanitizeReturnTo(null)).toBeNull();
    expect(sanitizeReturnTo(undefined)).toBeNull();
    expect(sanitizeReturnTo('')).toBeNull();
    expect(sanitizeReturnTo('   ')).toBeNull();
  });

  it('rejects protocol-relative URLs that would leave the site', () => {
    expect(sanitizeReturnTo('//evil.com/path')).toBeNull();
    expect(sanitizeReturnTo('/\\evil.com/path')).toBeNull();
    expect(sanitizeReturnTo('//evil.com')).toBeNull();
  });

  it('rejects absolute URLs and schemes', () => {
    expect(sanitizeReturnTo('https://evil.com/path')).toBeNull();
    expect(sanitizeReturnTo('http://evil.com')).toBeNull();
    expect(sanitizeReturnTo('javascript:alert(1)')).toBeNull();
    expect(sanitizeReturnTo('relative/path')).toBeNull();
  });

  it('rejects control characters (CR/LF/Tab) to prevent header injection', () => {
    expect(sanitizeReturnTo('/path\r\nSet-Cookie: x=1')).toBeNull();
    expect(sanitizeReturnTo('/path\nx')).toBeNull();
    expect(sanitizeReturnTo('/pa\tth')).toBeNull();
  });

  it('rejects over-long values', () => {
    expect(sanitizeReturnTo(`/${'a'.repeat(MAX_RETURN_TO_LENGTH)}`)).toBeNull();
    // 边界：恰好上限（'/' + 2047 字符 = 2048）合法
    expect(sanitizeReturnTo(`/${'a'.repeat(MAX_RETURN_TO_LENGTH - 1)}`)).toBe(`/${'a'.repeat(MAX_RETURN_TO_LENGTH - 1)}`);
  });

  it('rejects redirects back into auth endpoints to avoid a login loop', () => {
    expect(sanitizeReturnTo('/auth/github/login')).toBeNull();
    expect(sanitizeReturnTo('/auth/github/callback?code=x')).toBeNull();
    expect(sanitizeReturnTo('/auth/logout')).toBeNull();
    // 仅前缀形似但不是 /auth/ 目录的路径仍合法
    expect(sanitizeReturnTo('/authoring')).toBe('/authoring');
  });
});
