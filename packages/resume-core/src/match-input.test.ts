import { describe, expect, it } from 'vitest';
import { fromJobMatch, zeroResumeMatch } from './index.js';

describe('zeroResumeMatch', () => {
  it('returns an all-zero match for low-match fallback', () => {
    const m = zeroResumeMatch();
    expect(m.score).toBe(0);
    expect(m.matchedSkills).toEqual([]);
    expect(m.skillHits).toEqual([]);
    expect(m.fieldScores).toEqual({ title: 0, tags: 0, description: 0 });
  });

  it('returns independent fieldScores objects (no shared mutable reference)', () => {
    const a = zeroResumeMatch();
    const b = zeroResumeMatch();
    a.fieldScores.title = 9;
    expect(b.fieldScores.title).toBe(0);
  });
});

describe('fromJobMatch', () => {
  it('maps a full JobMatch-shaped object verbatim', () => {
    const out = fromJobMatch({
      score: 12,
      matchedSkills: ['typescript', 'react'],
      fieldScores: { title: 6, tags: 4, description: 2 },
      skillHits: [
        { skill: 'typescript', score: 8, fields: ['title', 'tags'] },
        { skill: 'react', score: 4, fields: ['tags'] },
      ],
    });
    expect(out.score).toBe(12);
    expect(out.matchedSkills).toEqual(['typescript', 'react']);
    expect(out.fieldScores).toEqual({ title: 6, tags: 4, description: 2 });
    expect(out.skillHits).toHaveLength(2);
    expect(out.skillHits[0]).toEqual({ skill: 'typescript', score: 8, fields: ['title', 'tags'] });
  });

  it('falls back to zero for null/undefined (zero-hit low_match path)', () => {
    for (const input of [null, undefined]) {
      const out = fromJobMatch(input);
      expect(out.score).toBe(0);
      expect(out.matchedSkills).toEqual([]);
      expect(out.fieldScores).toEqual({ title: 0, tags: 0, description: 0 });
      expect(out.skillHits).toEqual([]);
    }
  });

  it('fills missing fieldScores/skillHits with zero/empty instead of undefined', () => {
    const out = fromJobMatch({ score: 3, matchedSkills: ['go'] });
    expect(out.fieldScores).toEqual({ title: 0, tags: 0, description: 0 });
    expect(out.skillHits).toEqual([]);
    expect(out.matchedSkills).toEqual(['go']);
  });

  it('does not let a missing field score overwrite a provided one', () => {
    const out = fromJobMatch({
      score: 6,
      matchedSkills: ['rust'],
      fieldScores: { title: 6, tags: 0, description: 0 },
    });
    expect(out.fieldScores).toEqual({ title: 6, tags: 0, description: 0 });
  });

  it('coerces non-finite score to zero and non-array collections', () => {
    const out = fromJobMatch({
      score: Number.NaN,
      matchedSkills: undefined as unknown as string[],
      skillHits: undefined,
    });
    expect(out.score).toBe(0);
    expect(out.matchedSkills).toEqual([]);
    expect(out.skillHits).toEqual([]);
  });
});
