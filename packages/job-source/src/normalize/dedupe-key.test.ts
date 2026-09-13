import { describe, expect, it } from 'vitest';
import {
  canonicalizeUrl,
  normalizeCompanyName,
  normalizeSegment,
  makeNormalizedKey,
} from './dedupe-key.js';

describe('canonicalizeUrl', () => {
  it('strips tracking params, fragment and trailing slash, sorts params', () => {
    const out = canonicalizeUrl('https://example.com/jobs/3/?utm_source=x&b=2&a=1#section');
    expect(out).toBe('https://example.com/jobs/3?a=1&b=2');
  });

  it('lowercases host and keeps non-tracking params', () => {
    expect(canonicalizeUrl('https://RemoteOK.Com/remote-jobs/abc?gh_jid=9')).toBe(
      'https://remoteok.com/remote-jobs/abc?gh_jid=9',
    );
  });

  it('returns original for invalid url', () => {
    expect(canonicalizeUrl('not a url')).toBe('not a url');
  });
});

describe('normalizeCompanyName', () => {
  it('lowercases, strips punctuation and company suffixes', () => {
    expect(normalizeCompanyName('Acme, Inc.')).toBe('acme');
    expect(normalizeCompanyName('Foo Bar LTD')).toBe('foo bar');
    expect(normalizeSegment('  Hello,  World! ')).toBe('hello world');
  });
});

describe('makeNormalizedKey', () => {
  it('is stable across suffix/case/punctuation differences', () => {
    const k1 = makeNormalizedKey('Senior Engineer, Backend', 'Acme, Inc.', 'Remote, US');
    const k2 = makeNormalizedKey('senior engineer backend', 'acme', 'remote us');
    expect(k1).toBe(k2);
    expect(k1).toMatch(/^[0-9a-f]{40}$/);
  });

  it('differs for different titles', () => {
    expect(makeNormalizedKey('Frontend', 'Acme', null)).not.toBe(
      makeNormalizedKey('Backend', 'Acme', null),
    );
  });
});
