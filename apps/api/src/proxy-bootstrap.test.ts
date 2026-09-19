import { describe, expect, it } from 'vitest';
import { resolveOutboundProxy } from './proxy-bootstrap.js';

describe('resolveOutboundProxy', () => {
  it('returns undefined when no proxy env is set', () => {
    expect(resolveOutboundProxy({})).toBeUndefined();
  });

  it('prefers JOB_HTTP_PROXY over standard vars', () => {
    expect(
      resolveOutboundProxy({
        JOB_HTTP_PROXY: 'http://job:7897',
        HTTPS_PROXY: 'http://standard:8080',
      }),
    ).toBe('http://job:7897');
  });

  it('falls back to HTTPS_PROXY then HTTP_PROXY (upper and lower case)', () => {
    expect(resolveOutboundProxy({ HTTPS_PROXY: 'http://a:1' })).toBe('http://a:1');
    expect(resolveOutboundProxy({ https_proxy: 'http://b:2' })).toBe('http://b:2');
    expect(resolveOutboundProxy({ HTTP_PROXY: 'http://c:3' })).toBe('http://c:3');
    expect(resolveOutboundProxy({ http_proxy: 'http://d:4' })).toBe('http://d:4');
  });

  it('treats blank/whitespace values as unset', () => {
    expect(resolveOutboundProxy({ HTTPS_PROXY: '   ' })).toBeUndefined();
  });

  it('trims surrounding whitespace', () => {
    expect(resolveOutboundProxy({ JOB_HTTP_PROXY: ' http://127.0.0.1:7897 ' })).toBe(
      'http://127.0.0.1:7897',
    );
  });
});
