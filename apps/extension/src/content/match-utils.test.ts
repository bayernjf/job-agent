import { describe, expect, it } from 'vitest';
import { matchTier, resolveEvidenceLinks, type MatchTier } from './match-utils.js';
import type { EvidenceBrief } from '../lib/api.js';

describe('matchTier', () => {
  it('returns high when score >= 80% of max', () => {
    // 1 skill, max=6, score=5 => 83%
    expect(matchTier(5, ['TypeScript'])).toBe<MatchTier>('high');
    // 2 skills, max=12, score=10 => 83%
    expect(matchTier(10, ['TypeScript', 'React'])).toBe<MatchTier>('high');
  });

  it('returns mid when score >= 40% but < 80%', () => {
    // 1 skill, max=6, score=3 => 50%
    expect(matchTier(3, ['TypeScript'])).toBe<MatchTier>('mid');
    // 2 skills, max=12, score=5 => 42%
    expect(matchTier(5, ['TypeScript', 'React'])).toBe<MatchTier>('mid');
  });

  it('returns low when score < 40%', () => {
    // 1 skill, max=6, score=2 => 33%
    expect(matchTier(2, ['TypeScript'])).toBe<MatchTier>('low');
    // 3 skills, max=18, score=5 => 28%
    expect(matchTier(5, ['a', 'b', 'c'])).toBe<MatchTier>('low');
  });

  it('returns low for empty matchedSkills (no max denominator)', () => {
    expect(matchTier(0, [])).toBe<MatchTier>('low');
    expect(matchTier(3, [])).toBe<MatchTier>('low');
  });
});

describe('resolveEvidenceLinks', () => {
  const dict: Record<string, EvidenceBrief> = {
    ev1: { sourceType: 'commit', url: 'https://github.com/x/commit/1', claim: 'Added auth module', occurredAt: '2026-01-01' },
    ev2: { sourceType: 'pr', url: 'https://github.com/x/pull/2', claim: 'Refactored matcher to support field scores with a very long claim that exceeds sixty characters for truncation testing' },
    ev3: { sourceType: 'commit', url: 'https://github.com/x/commit/1', claim: 'Duplicate URL different ref' },
  };

  it('resolves refs to links with labels', () => {
    const links = resolveEvidenceLinks(['ev1', 'ev2'], dict);
    expect(links).toHaveLength(2);
    expect(links[0]!.url).toBe('https://github.com/x/commit/1');
    expect(links[0]!.label).toBe('Added auth module');
  });

  it('deduplicates by URL (ev1 and ev3 share url)', () => {
    const links = resolveEvidenceLinks(['ev1', 'ev3'], dict);
    expect(links).toHaveLength(1);
    expect(links[0]!.url).toBe('https://github.com/x/commit/1');
  });

  it('truncates labels over 60 chars with ellipsis', () => {
    const links = resolveEvidenceLinks(['ev2'], dict);
    expect(links).toHaveLength(1);
    expect(links[0]!.label.length).toBeLessThanOrEqual(60);
    expect(links[0]!.label.endsWith('…')).toBe(true);
  });

  it('returns empty for unknown refs', () => {
    expect(resolveEvidenceLinks(['nonexistent'], dict)).toEqual([]);
  });

  it('returns empty when dict is undefined', () => {
    expect(resolveEvidenceLinks(['ev1'], undefined)).toEqual([]);
  });

  it('returns empty for empty refs', () => {
    expect(resolveEvidenceLinks([], dict)).toEqual([]);
  });
});
