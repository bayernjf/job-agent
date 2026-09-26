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

  it('attaches the cross-source fusion report to the snapshot when provided', () => {
    const input = buildInput();
    const fusion = {
      primaryPlatform: 'github' as const,
      secondaryPlatform: 'gitee' as const,
      mergedMirrors: [{ primaryRef: 'o/r', secondaryRef: 'o/r-mirror', sharedOidCount: 4 }],
      suspectedMirrors: [],
      dedupedCommitCount: 3,
      dedupedPullRequestCount: 1,
      dedupedIssueCount: 2,
      keptSecondaryRepoRefs: [],
      counts: {
        primaryRepos: 1,
        secondaryRepos: 1,
        fusedRepos: 1,
        primaryCommits: 10,
        secondaryCommits: 7,
        fusedCommits: 14,
        primaryPullRequests: 2,
        secondaryPullRequests: 2,
        fusedPullRequests: 3,
        primaryIssues: 3,
        secondaryIssues: 3,
        fusedIssues: 4,
      },
    };
    const profile = analyze(input, { profileId: 'fused-p', fusion });
    expect(profile.fusion?.dedupedCommitCount).toBe(3);
    expect(profile.fusion?.mergedMirrors[0]?.sharedOidCount).toBe(4);
    expect(AbilityProfileSchema.safeParse(profile).success).toBe(true);
  });

  it('omits fusion from a single-source profile', () => {
    const profile = analyze(buildInput(), { profileId: 'single-p' });
    expect(profile.fusion).toBeUndefined();
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

  it('stores the PR summary exactly as the pre-composer sentence, byte for byte', () => {
    // 快照里存的是数据层英文原句；渲染侧改用 composePrSummary 后，这句必须逐字节不变，
    // 否则同一 analyzerVersion 会对应两套 prSummary。字面量写在测试里，不从 composer 反推。
    const input = buildInput();
    const opened = input.pullRequests.length;
    const merged = input.pullRequests.filter((p) => p.state === 'MERGED').length;
    const external = input.pullRequests.filter(
      (p) => !p.repoOwnerIsSelf && p.state === 'MERGED',
    ).length;
    const literal = `${opened} PR(s) opened, ${merged} merged${
      external > 0 ? `, ${external} into external projects` : ''
    }`;
    expect(analyze(input, { profileId: 'p-pr' }).collaboration.prSummary).toBe(literal);
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
