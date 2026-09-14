import { describe, expect, it } from 'vitest';
import { analyze, RULE_VERSION } from './index.js';
import { AbilityProfileSchema, SCHEMA_VERSION } from '@jobagent/shared';
import { buildInput } from './test-input.js';

describe('analyze (profile assembly)', () => {
  it('supports gitee platform via AnalyzeOptions and keeps schema valid', () => {
    const input = buildInput();
    const profile = analyze(input, { profileId: 'gitee-p', platform: 'gitee' });
    expect(profile.subject.platform).toBe('gitee');
    expect(profile.caveats.some((c) => c.includes('Public Gitee data only'))).toBe(true);
    expect(profile.caveats.some((c) => c.includes('sampled L1 window'))).toBe(true);
    expect(AbilityProfileSchema.safeParse(profile).success).toBe(true);
  });

  it('produces a deterministic, schema-valid profile for a strong account', () => {
    const input = buildInput();
    const profile = analyze(input, { profileId: 'test-profile-1' });
    expect(profile.profileId).toBe('test-profile-1');
    expect(profile.analyzerVersion).toBe(`${SCHEMA_VERSION}-${RULE_VERSION}`);
    expect(profile.generatedAt).toBe(input.collectedAt);
    expect(profile.analysisLayers).toEqual(['L0', 'L1']);
    expect(profile.subject).toMatchObject({
      platform: 'github',
      login: 'dev-strong',
      claimed: false,
    });
    expect(profile.authenticity.status).toBe('likely_authentic');
    expect(profile.skillTags.length).toBeGreaterThan(0);
    expect(profile.interviewQuestions.length).toBeGreaterThan(0);
    expect(profile.caveats.length).toBeGreaterThanOrEqual(3);
  });

  it('same input + different profileId still yields identical content (determinism)', () => {
    const input = buildInput();
    const a = analyze(input, { profileId: 'id-a' });
    const b = analyze(input, { profileId: 'id-b' });
    expect(a).toEqual({ ...b, profileId: 'id-a' });
  });

  it('propagates missing data into caveats instead of hiding it', () => {
    const input = buildInput({ missing: ['commits:web-platform'] });
    const profile = analyze(input, { profileId: 'p' });
    expect(profile.caveats.some((c) => c.includes('commits:web-platform'))).toBe(true);
  });

  it('marks insufficient accounts explicitly', () => {
    const input = buildInput({
      repos: [],
      commits: [],
      pullRequests: [],
      issues: [],
      contributions: {
        totalCommitContributions: 0,
        totalPullRequestContributions: 0,
        totalIssueContributions: 0,
        totalRepositoryContributions: 0,
        contributionMonths: [],
      },
    });
    const profile = analyze(input, { profileId: 'p-quiet' });
    expect(profile.authenticity.status).toBe('insufficient_data');
    expect(profile.authenticity.confidence).toBe(0.35);
  });
});
