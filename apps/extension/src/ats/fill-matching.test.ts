import { describe, expect, it } from 'vitest';
import { matchFillsToPage, urlMatchesPage } from './fill-matching.js';
import type { PendingFill } from '../lib/api.js';

function fill(overrides: Partial<PendingFill['job']> = {}): PendingFill {
  return {
    intentId: 'intent-1',
    runId: 'run-1',
    profileId: 'p-1',
    job: {
      source: 'greenhouse',
      sourceUrl: 'https://boards.greenhouse.io/acme/jobs/123',
      title: 'Senior Engineer',
      ...overrides,
    },
    matchScore: 80,
    matchTier: 'high',
    approvedAt: '2026-10-04T00:00:00.000Z',
  };
}

describe('urlMatchesPage', () => {
  it('matches the exact job url ignoring query and hash', () => {
    expect(
      urlMatchesPage('https://boards.greenhouse.io/acme/jobs/123', 'https://boards.greenhouse.io/acme/jobs/123?gh_src=abc'),
    ).toBe(true);
  });

  it('matches the /apply sub-path of the job url', () => {
    expect(
      urlMatchesPage('https://boards.greenhouse.io/acme/jobs/123', 'https://boards.greenhouse.io/acme/jobs/123/apply'),
    ).toBe(true);
    expect(
      urlMatchesPage('https://boards.greenhouse.io/acme/jobs/123/apply', 'https://boards.greenhouse.io/acme/jobs/123'),
    ).toBe(true);
  });

  it('does not match a different job id by loose prefix', () => {
    expect(
      urlMatchesPage('https://boards.greenhouse.io/acme/jobs/1', 'https://boards.greenhouse.io/acme/jobs/10/apply'),
    ).toBe(false);
  });

  it('requires the same host', () => {
    expect(
      urlMatchesPage('https://boards.greenhouse.io/acme/jobs/123', 'https://jobs.lever.co/acme/abc/apply'),
    ).toBe(false);
  });

  it('ignores leading www. and trailing slash and case', () => {
    expect(urlMatchesPage('https://WWW.example.com/Jobs/1/', 'https://example.com/jobs/1/apply')).toBe(true);
  });

  it('returns false for malformed urls', () => {
    expect(urlMatchesPage('not a url', 'https://example.com/jobs/1')).toBe(false);
  });
});

describe('matchFillsToPage', () => {
  it('returns fills whose sourceUrl or applyUrl matches the page', () => {
    const a: PendingFill = {
      ...fill({ sourceUrl: 'https://boards.greenhouse.io/acme/jobs/1' }),
      intentId: 'intent-gh',
    };
    const b: PendingFill = {
      ...fill({
        sourceUrl: 'https://jobs.lever.co/acme/abc',
        applyUrl: 'https://jobs.lever.co/acme/abc/apply',
      }),
      intentId: 'intent-lever',
    };
    const c: PendingFill = {
      ...fill({ sourceUrl: 'https://boards.greenhouse.io/other/jobs/9' }),
      intentId: 'intent-other',
    };
    const matched = matchFillsToPage([a, b, c], 'https://jobs.lever.co/acme/abc/apply');
    expect(matched.map((f) => f.intentId)).toEqual(['intent-lever']);
  });

  it('returns an empty list when nothing matches', () => {
    expect(matchFillsToPage([fill()], 'https://jobs.lever.co/acme/nope')).toEqual([]);
  });
});
