import { describe, expect, it } from 'vitest';
import { matchScoreTier } from '@jobagent/shared';
import { AGENT_RULE_VERSION } from './rules.js';
import {
  MATCH_FIELD_POINTS,
  buildMatchReport,
  matchGaps,
  matchReasons,
  selectCandidates,
  selectCandidatesForPreference,
} from './match-report.js';
import { planIntents, toSubmitIntentJob, type IntentJobSnapshotSource } from './plan.js';
import type { MatchLike } from './match-report.js';
import type { PreferencePostingLike } from './preferences.js';

/** 一个技能满分 6 = title 3 + tags 2 + description 1（与 job-source 的权重一致）。 */
function match(overrides: Partial<MatchLike> = {}): MatchLike {
  return {
    score: 6,
    matchedSkills: ['TypeScript'],
    fieldScores: { title: 3, tags: 2, description: 1 },
    skillHits: [{ skill: 'TypeScript', score: 6, fields: ['title', 'tags', 'description'] }],
    ...overrides,
  };
}

function posting(overrides: Partial<PreferencePostingLike> = {}): PreferencePostingLike {
  return {
    jobId: 'job-1',
    source: 'greenhouse',
    title: 'Senior Full Stack Engineer',
    company: 'Acme Inc',
    location: 'Remote - US',
    remote: true,
    salaryMin: 120000,
    salaryMax: 160000,
    tags: ['TypeScript', 'React'],
    description: 'Build web apps with Node.js',
    postedAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('MATCH_FIELD_POINTS', () => {
  it('pins the same weights as job-source MATCH_FIELD_WEIGHTS (title 3 / tags 2 / description 1)', () => {
    expect(MATCH_FIELD_POINTS).toEqual({ title: 3, tags: 2, description: 1 });
  });
});

describe('matchReasons', () => {
  it('turns each skill-hit field into a code + fact (no English prose in the snapshot)', () => {
    expect(matchReasons(match())).toEqual([
      { code: 'title_match', skill: 'TypeScript', points: 3 },
      { code: 'tag_match', skill: 'TypeScript', points: 2 },
      { code: 'description_match', skill: 'TypeScript', points: 1 },
    ]);
  });

  it('keeps multi-skill hits in order', () => {
    const reasons = matchReasons({
      skillHits: [
        { skill: 'Go', score: 3, fields: ['title'] },
        { skill: 'React', score: 2, fields: ['tags'] },
      ],
    });
    expect(reasons).toEqual([
      { code: 'title_match', skill: 'Go', points: 3 },
      { code: 'tag_match', skill: 'React', points: 2 },
    ]);
  });
});

describe('matchGaps', () => {
  it('reports job tags the profile cannot back with evidence, normalized and deduped', () => {
    expect(
      matchGaps(['TypeScript', 'Kubernetes', 'KUBERNETES', '', 'Node.js'], ['typescript', 'Node.js']),
    ).toEqual([{ code: 'tag_not_in_profile', tag: 'Kubernetes' }]);
  });

  it('caps the number of gaps', () => {
    expect(matchGaps(['a1', 'b2', 'c3'], [], 2)).toHaveLength(2);
  });
});

describe('buildMatchReport', () => {
  it('reuses shared.matchScoreTier so the workbench tier equals the report page tier', () => {
    const report = buildMatchReport({ match: match(), tags: ['TypeScript'], profileSkills: ['TypeScript'] });
    // 报告自带规则版本，保证「同一版本 → 同一份报告」可复现
    expect(report.ruleVersion).toBe(AGENT_RULE_VERSION);
    expect(report.tier).toBe(matchScoreTier(6, 1));
    expect(report.tier).toBe('high');
    expect(report.score).toBe(6);
    expect(report.fieldScores).toEqual({ title: 3, tags: 2, description: 1 });
    expect(report.matchedSkills).toEqual(['TypeScript']);
    expect(report.gaps).toEqual([]);
    expect(report.suggestedBoost).toEqual([]);
  });

  it('turns gaps into honest "add evidence for tag" boosts', () => {
    const report = buildMatchReport({
      match: match({ score: 3, matchedSkills: ['Go'], fieldScores: { title: 3, tags: 0, description: 0 }, skillHits: [{ skill: 'Go', score: 3, fields: ['title'] }] }),
      tags: ['Kubernetes'],
      profileSkills: ['Go'],
    });
    expect(report.gaps).toEqual([{ code: 'tag_not_in_profile', tag: 'Kubernetes' }]);
    expect(report.suggestedBoost).toEqual([{ code: 'add_evidence_for_tag', skill: 'Kubernetes' }]);
    expect(report.tier).toBe(matchScoreTier(3, 1)); // 3/6 = 50% → mid
    expect(report.tier).toBe('mid');
  });
});

describe('selectCandidates', () => {
  const strong: MatchLike = match();
  const weak: MatchLike = match({
    score: 2,
    matchedSkills: ['Go'],
    fieldScores: { title: 0, tags: 0, description: 1 },
    skillHits: [{ skill: 'Go', score: 2, fields: ['description'] }],
  });

  it('drops candidates below the quality gate instead of padding the list', () => {
    const items = [
      { match: strong, posting: posting({ jobId: 'a' }) },
      { match: weak, posting: posting({ jobId: 'b', title: 'Go Engineer' }) },
    ];
    expect(selectCandidates(items, { minTier: 'mid' }).map((i) => i.posting.jobId)).toEqual(['a']);
    expect(selectCandidates(items, { minTier: 'low' })).toHaveLength(2);
  });

  it('excludes job ids that already have a ticket, sorts by score then postedAt, and caps the limit', () => {
    const items = [
      { match: match({ score: 6 }), posting: posting({ jobId: 'a', postedAt: '2026-10-01T00:00:00.000Z' }) },
      { match: match({ score: 6 }), posting: posting({ jobId: 'b', postedAt: '2026-10-02T00:00:00.000Z' }) },
      { match: match({ score: 4, matchedSkills: ['Go', 'Rust'], fieldScores: { title: 3, tags: 0, description: 1 }, skillHits: [] }), posting: posting({ jobId: 'c' }) },
      { match: match({ score: 6 }), posting: posting({ jobId: 'skip-me' }) },
    ];
    const selected = selectCandidates(items, {
      minTier: 'mid',
      limit: 2,
      excludeJobIds: new Set(['skip-me']),
    });
    expect(selected.map((i) => i.posting.jobId)).toEqual(['b', 'a']);
  });

  it('puts whitelisted companies first without dropping anyone', () => {
    // 两条都过质量闸（score 6 / 1 个命中技能 = high），只有白名单优先级不同
    const items = [
      { match: match({ score: 6 }), posting: posting({ jobId: 'low-prio' }) },
      { match: match({ score: 6 }), posting: posting({ jobId: 'whitelisted', company: 'Stripe' }) },
    ];
    const selected = selectCandidatesForPreference(items, {
      minTier: 'mid',
      preferredCompanyTerms: ['Stripe'],
    });
    expect(selected.map((i) => i.posting.jobId)).toEqual(['whitelisted', 'low-prio']);
  });

  it('returns an empty list when everything is filtered out', () => {
    expect(selectCandidates([], { minTier: 'low' })).toEqual([]);
  });
});

describe('plan', () => {
  it('snapshots the posting without the heavy description field', () => {
    const snapshot = toSubmitIntentJob({
      ...posting({ jobId: 'job-9' }),
      sourceUrl: 'https://boards.greenhouse.io/acme/jobs/9',
      applyUrl: 'https://boards.greenhouse.io/acme/jobs/9/apply',
      salaryCurrency: 'USD',
    });
    expect(snapshot).toEqual({
      jobId: 'job-9',
      source: 'greenhouse',
      sourceUrl: 'https://boards.greenhouse.io/acme/jobs/9',
      applyUrl: 'https://boards.greenhouse.io/acme/jobs/9/apply',
      title: 'Senior Full Stack Engineer',
      company: 'Acme Inc',
      location: 'Remote - US',
      remote: true,
      salaryMin: 120000,
      salaryMax: 160000,
      salaryCurrency: 'USD',
      tags: ['TypeScript', 'React'],
      postedAt: '2026-10-01T00:00:00.000Z',
    });
    expect('description' in snapshot).toBe(false);
  });

  it('plans intents from the same match object that passed the gate (score/tier are consistent)', () => {
    const snapshotSource: IntentJobSnapshotSource = { ...posting(), sourceUrl: 'https://x.test/1' };
    const planned = planIntents([{ match: match(), posting: snapshotSource }], {
      profileSkills: ['TypeScript'],
      maxGaps: 1,
    });
    expect(planned).toHaveLength(1);
    expect(planned[0]!.matchScore).toBe(6);
    expect(planned[0]!.matchTier).toBe('high');
    expect(planned[0]!.report.score).toBe(6);
    expect(planned[0]!.job.sourceUrl).toBe('https://x.test/1');
  });
});
