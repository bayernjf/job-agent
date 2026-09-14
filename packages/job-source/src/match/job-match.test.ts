import { describe, expect, it } from 'vitest';
import type { JobPosting, JobSource } from '@jobagent/shared';
import { matchJobs, MATCH_FIELD_WEIGHTS } from './job-match.js';

let seq = 0;
function posting(overrides: Partial<JobPosting> & { title: string }): JobPosting {
  seq += 1;
  return {
    jobId: `j${seq}`,
    source: 'remoteok' as JobSource,
    sourceUrl: `https://example.test/${seq}`,
    company: 'Acme',
    remote: false,
    postedAt: '2026-09-01T00:00:00.000Z',
    fetchedAt: '2026-09-13T00:00:00.000Z',
    tags: [],
    ...overrides,
  };
}

describe('matchJobs scoring', () => {
  it('weights title above tags above description', () => {
    const inTitle = posting({ title: 'Senior Python Engineer', description: 'generic' });
    const inDesc = posting({ title: 'Backend Engineer', description: 'we use python daily' });
    const out = matchJobs([inDesc, inTitle], { skills: ['python'] });
    expect(out.map((m) => m.posting.jobId)).toEqual([inTitle.jobId, inDesc.jobId]);
    expect(out[0]!.score).toBe(3); // title only
    expect(out[1]!.score).toBe(1); // description only
  });

  it('sums fields and records matched skills', () => {
    const p = posting({
      title: 'TypeScript Engineer',
      tags: ['typescript', 'react'],
      description: 'typescript and react work',
    });
    const out = matchJobs([p], { skills: ['TypeScript', 'React', 'Rust'] });
    expect(out).toHaveLength(1);
    // TS: title 3 + tag 2 + desc 1 = 6 ; React: tag 2 + desc 1 = 3 ; total 9
    expect(out[0]!.score).toBe(9);
    expect(out[0]!.matchedSkills).toEqual(['TypeScript', 'React']);
  });

  it('matches on word boundaries (java does not hit javascript)', () => {
    const js = posting({ title: 'JavaScript Developer', description: '' });
    const java = posting({ title: 'Java Backend Engineer', description: '' });
    const out = matchJobs([js, java], { skills: ['java'] });
    expect(out).toHaveLength(1);
    expect(out[0]!.posting.jobId).toBe(java.jobId);
  });

  it('is case- and punctuation-insensitive', () => {
    const p = posting({ title: 'Node.js Backend', description: '' });
    const out = matchJobs([p], { skills: ['node.js'] });
    expect(out).toHaveLength(1);
  });

  it('drops postings with zero skill hits and returns [] for empty skills', () => {
    const p = posting({ title: 'Sales Manager', description: '' });
    expect(matchJobs([p], { skills: ['python'] })).toHaveLength(0);
    expect(matchJobs([p], { skills: [] })).toHaveLength(0);
  });
});

describe('matchJobs hard filters and ordering', () => {
  it('filters by remote', () => {
    const remote = posting({ title: 'Python Engineer', remote: true });
    const onsite = posting({ title: 'Python Engineer', remote: false });
    const out = matchJobs([remote, onsite], { skills: ['python'], remote: true });
    expect(out).toHaveLength(1);
    expect(out[0]!.posting.jobId).toBe(remote.jobId);
  });

  it('filters by salary floor, excluding postings without salary data', () => {
    const high = posting({ title: 'Python', salaryMin: 180_000, salaryMax: 220_000, salaryCurrency: 'USD' });
    const low = posting({ title: 'Python', salaryMin: 80_000, salaryMax: 100_000, salaryCurrency: 'USD' });
    const unknown = posting({ title: 'Python' });
    const out = matchJobs([high, low, unknown], { skills: ['python'], salaryMinUsd: 150_000 });
    expect(out.map((m) => m.posting.jobId)).toEqual([high.jobId]);
  });

  it('filters by source', () => {
    const a = posting({ title: 'Python', source: 'remoteok' });
    const b = posting({ title: 'Python', source: 'lever' });
    const out = matchJobs([a, b], { skills: ['python'], sources: ['lever'] });
    expect(out.map((m) => m.posting.jobId)).toEqual([b.jobId]);
  });

  it('orders by score desc then newest postedAt desc, and honors limit', () => {
    const strong = posting({ title: 'Python Engineer', tags: ['python'], postedAt: '2026-09-01T00:00:00.000Z' });
    const newerTie = posting({ title: 'Python Engineer', postedAt: '2026-09-05T00:00:00.000Z' });
    const olderTie = posting({ title: 'Python Engineer', postedAt: '2026-09-01T00:00:00.000Z' });
    const out = matchJobs([olderTie, strong, newerTie], { skills: ['python'] });
    // strong: title 3 + tag 2 = 5 first; ties (3) ordered newest first
    expect(out.map((m) => m.posting.jobId)).toEqual([strong.jobId, newerTie.jobId, olderTie.jobId]);
    const limited = matchJobs([olderTie, strong, newerTie], { skills: ['python'], limit: 2 });
    expect(limited).toHaveLength(2);
  });
});

describe('matchJobs explainability (decision #10)', () => {
  it('splits the score into per-field contributions', () => {
    const p = posting({
      title: 'TypeScript Engineer',
      tags: ['typescript', 'react'],
      description: 'typescript and react work',
    });
    const out = matchJobs([p], { skills: ['TypeScript', 'React'] });
    const m = out[0]!;
    // TypeScript hits title(3)+tags(2)+description(1); React hits tags(2)+description(1)
    expect(m.fieldScores).toEqual({ title: 3, tags: 4, description: 2 });
    expect(m.score).toBe(9);
    // fieldScores always reconciles to the total score
    expect(m.fieldScores.title + m.fieldScores.tags + m.fieldScores.description).toBe(m.score);
  });

  it('records per-skill hit fields and contribution in matched order', () => {
    const p = posting({
      title: 'Senior React Engineer',
      tags: ['react', 'typescript'],
      description: 'react daily',
    });
    const out = matchJobs([p], { skills: ['TypeScript', 'React'] });
    const m = out[0]!;
    expect(m.skillHits).toEqual([
      // Per-skill hits follow the input skills order (postings are what get
      // score-sorted, not the skills inside one posting).
      // TypeScript: tags only = 2
      { skill: 'TypeScript', score: 2, fields: ['tags'] },
      // React: title 3 + tags 2 + description 1 = 6
      { skill: 'React', score: 6, fields: ['title', 'tags', 'description'] },
    ]);
    // matchedSkills stays a backward-compatible projection of skillHits
    expect(m.matchedSkills).toEqual(m.skillHits.map((h) => h.skill));
  });

  it('exposes field weights used for the breakdown', () => {
    expect(MATCH_FIELD_WEIGHTS).toEqual({ title: 3, tags: 2, description: 1 });
  });
});
