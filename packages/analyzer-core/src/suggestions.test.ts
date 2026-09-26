import { composeImprovementSuggestion } from '@jobagent/shared';
import { describe, expect, it } from 'vitest';
import type { AnalyzerInput } from './input.js';
import { computeImprovementSuggestions } from './suggestions.js';

function baseInput(): AnalyzerInput {
  return {
    subject: { login: 't', profileUrl: 'https://github.com/t', platform: 'github' },
    dataWindow: { since: '2026-01-01T00:00:00.000Z', until: '2026-09-01T00:00:00.000Z' },
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
    evidence: [],
  } as unknown as AnalyzerInput;
}

function commitEvidence(n: number): AnalyzerInput['evidence'] {
  return Array.from({ length: n }, (_, i) => ({
    evidenceId: `commit:${i}`,
    sourcePlatform: 'github',
    sourceType: 'commit' as const,
    url: `https://github.com/t/r/commit/${i}`,
    layer: 'L1' as const,
    claim: `commit ${i}`,
    rawRef: `r/${i}`,
  }));
}

function commitsOnlyInput(count = 12): AnalyzerInput {
  const input = baseInput();
  input.commits = Array.from({ length: count }, (_, i) => ({
    oid: `${i}`,
    committedAt: '2026-03-01T00:00:00.000Z',
    authorName: 't',
    authorEmail: null,
    repoName: 'r',
    messageHeadline: `c${i}`,
  }) as AnalyzerInput['commits'][number]);
  input.evidence = commitEvidence(count);
  return input;
}

/** 有 PR，但全部合进自己的仓库 → 外部贡献缺失。 */
function ownRepoPrInput(): AnalyzerInput {
  const input = baseInput();
  input.pullRequests = [
    {
      number: 1,
      title: 'a',
      url: 'https://github.com/t/r/pull/1',
      state: 'MERGED',
      createdAt: '2026-03-01T00:00:00.000Z',
      mergedAt: '2026-03-02T00:00:00.000Z',
      repoNameWithOwner: 't/r',
      repoIsFork: false,
      repoOwnerIsSelf: true,
    } as AnalyzerInput['pullRequests'][number],
  ];
  input.evidence = [
    {
      evidenceId: 'pr:1',
      sourcePlatform: 'github',
      sourceType: 'pr' as const,
      url: 'https://github.com/t/r/pull/1',
      layer: 'L1' as const,
      claim: 'merged pr 1',
      rawRef: 'r/1',
    },
  ];
  return input;
}

function suggestions(input: AnalyzerInput) {
  return computeImprovementSuggestions(input) ?? [];
}

describe('computeImprovementSuggestions（T09）', () => {
  it('suggests opening pull requests when commits exist but no PR was opened', () => {
    const got = suggestions(commitsOnlyInput());
    expect(got).toHaveLength(1);
    expect(got[0]!.code).toBe('no_pull_requests');
    expect(got[0]!.suggestion).toContain('Move your work into pull requests');
    expect(got[0]!.evidenceRefs).toEqual(['commit:0', 'commit:1', 'commit:2']);
  });

  it('suggests external contributions when all merged PRs point back to own repos', () => {
    const got = suggestions(ownRepoPrInput());
    expect(got).toHaveLength(1);
    expect(got[0]!.code).toBe('no_external_contributions');
    expect(got[0]!.suggestion).toContain('outside your own repositories');
    expect(got[0]!.evidenceRefs).toEqual(['pr:1']);
  });

  it('produces nothing when both conditions are absent', () => {
    const input = baseInput();
    input.commits = [0, 1, 2].map((i) => ({
      oid: `${i}`,
      committedAt: '2026-03-01T00:00:00.000Z',
      authorName: 't',
      authorEmail: null,
      repoName: 'r',
      messageHeadline: `c${i}`,
    }) as AnalyzerInput['commits'][number]);
    input.pullRequests = [
      {
        number: 1,
        title: 'a',
        url: 'https://github.com/up/r/pull/1',
        state: 'MERGED',
        createdAt: '2026-03-01T00:00:00.000Z',
        mergedAt: '2026-03-02T00:00:00.000Z',
        repoNameWithOwner: 'up/r',
        repoIsFork: false,
        repoOwnerIsSelf: false,
      } as AnalyzerInput['pullRequests'][number],
    ];
    input.evidence = [
      ...commitEvidence(3),
      {
        evidenceId: 'pr:1',
        sourcePlatform: 'github',
        sourceType: 'pr' as const,
        url: 'https://github.com/up/r/pull/1',
        layer: 'L1' as const,
        claim: 'merged pr 1',
        rawRef: 'up/r/1',
      },
    ];

    expect(computeImprovementSuggestions(input)).toBeUndefined();
  });

  it('stores exactly the English sentence the render side composes from the code', () => {
    const cases = [
      ['no_pull_requests', commitsOnlyInput()],
      ['no_external_contributions', ownRepoPrInput()],
    ] as const;
    for (const [code, input] of cases) {
      const got = suggestions(input);
      expect(got).toHaveLength(1);
      expect(got[0]).toEqual({
        code,
        ...composeImprovementSuggestion(code, 'en'),
        evidenceRefs: got[0]!.evidenceRefs,
      });
    }
  });
});
