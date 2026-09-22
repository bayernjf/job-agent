import { describe, expect, it } from 'vitest';
import { computeAuthenticity, computeAuthenticitySignals } from './signals.js';
import { computeActivity } from './activity.js';
import { SIGNAL_CODES } from './rules.js';
import { buildInput } from './test-input.js';
import type { AnalyzerCommit, AnalyzerInput, AnalyzerPullRequest, AnalyzerRepo } from './input.js';

/** 断言所有信号的 evidenceRefs 都真实存在（无证据不下结论） */
function expectValidRefs(input: AnalyzerInput): void {
  const known = new Set(input.evidence.map((e) => e.evidenceId));
  for (const signal of computeAuthenticitySignals(input)) {
    for (const ref of signal.evidenceRefs) {
      expect(known.has(ref), `signal ${signal.code} references unknown evidence ${ref}`).toBe(true);
    }
  }
}

describe('computeAuthenticitySignals', () => {
  it('produces no risk signal for a strong account and all refs are valid', () => {
    const input = buildInput();
    const signals = computeAuthenticitySignals(input);
    expect(signals.filter((s) => s.severity === 'risk')).toHaveLength(0);
    expect(signals.some((s) => s.code === SIGNAL_CODES.EXTERNAL_CONTRIBUTIONS)).toBe(true);
    expectValidRefs(input);
  });

  it('flags warn (not risk) when only emails mismatch (privacy settings are common)', () => {
    const input = buildInput({ email: 'someone.else@example.com' });
    const signals = computeAuthenticitySignals(input);
    const author = signals.find((s) => s.code === SIGNAL_CODES.AUTHOR_INCONSISTENCY);
    expect(author?.severity).toBe('warn');
    expectValidRefs(input);
  });

  it('escalates to risk only when both email and name mismatch', () => {
    const mismatchedCommits: AnalyzerCommit[] = Array.from({ length: 3 }, (_, i) => ({
      oid: `mm${String(i + 1).padStart(2, '0')}${'0'.repeat(36)}`,
      committedAt: `2026-0${i + 1}-15T10:00:00Z`,
      authorName: 'Someone Else',
      authorEmail: 'someone.else@example.com',
      repoName: 'dev-strong/web-platform',
      messageHeadline: `mismatched commit ${i}`,
    }));
    const input = buildInput({
      email: 'other@example.com',
      commits: mismatchedCommits,
      pullRequests: [], // no external contributions so author risk is not mitigated
    });
    const author = computeAuthenticitySignals(input).find(
      (s) => s.code === SIGNAL_CODES.AUTHOR_INCONSISTENCY,
    );
    expect(author?.severity).toBe('risk');
    expectValidRefs(input);
  });

  it('flags warn on author name mismatch when email is unknown', () => {
    const commits: AnalyzerCommit[] = [
      {
        oid: 'aa01bb02cc03dd04ee05ff06aa07bb08cc09dd0e',
        committedAt: '2026-03-15T10:00:00Z',
        authorName: 'Someone Else',
        authorEmail: null,
        repoName: 'dev-strong/web-platform',
        messageHeadline: 'fix: x',
      },
      {
        oid: 'aa02bb03cc04dd05ee06ff07aa08bb09cc0ddaa1',
        committedAt: '2026-04-15T10:00:00Z',
        authorName: 'Another Person',
        authorEmail: null,
        repoName: 'dev-strong/web-platform',
        messageHeadline: 'fix: y',
      },
      {
        oid: 'aa03bb04cc05dd06ee07ff08aa09bb0acc0ddaa2',
        committedAt: '2026-05-15T10:00:00Z',
        authorName: 'Third Person',
        authorEmail: null,
        repoName: 'dev-strong/web-platform',
        messageHeadline: 'fix: z',
      },
    ];
    const input = buildInput({ email: null, displayName: 'Dev Strong', commits });
    const author = computeAuthenticitySignals(input).find(
      (s) => s.code === SIGNAL_CODES.AUTHOR_INCONSISTENCY,
    );
    expect(author?.severity).toBe('warn');
    expectValidRefs(input);
  });

  it('flags commit burst with adjacent silence', () => {
    const bursts: AnalyzerCommit[] = Array.from({ length: 40 }, (_, i) => ({
      oid: `burst${String(i).padStart(2, '0')}${'0'.repeat(32)}`,
      committedAt: `2026-03-${String((i % 28) + 1).padStart(2, '0')}T10:00:00Z`,
      authorName: 'Dev Strong',
      authorEmail: 'dev.strong@example.com',
      repoName: 'dev-strong/web-platform',
      messageHeadline: `batch commit ${i}`,
    }));
    const input = buildInput({ commits: bursts });
    const burst = computeAuthenticitySignals(input).find(
      (s) => s.code === SIGNAL_CODES.COMMIT_BURST,
    );
    expect(burst?.severity).toBe('warn');
    expectValidRefs(input);
  });

  it('flags high star count with very low commit activity as risk', () => {
    const starRepos: AnalyzerRepo[] = [
      {
        name: 'repo-a',
        ownerLogin: 'dev-suspicious',
        url: 'https://github.com/dev-suspicious/repo-a',
        isFork: false,
        isArchived: false,
        primaryLanguage: 'TypeScript',
        topics: [],
        description: null,
        stargazerCount: 3000,
        forkCount: 4,
        pushedAt: '2026-01-05T00:00:00Z',
        createdAt: '2024-09-01T00:00:00Z',
      },
    ];
    const input = buildInput({
      login: 'dev-suspicious',
      displayName: 'Dev Suspicious',
      repos: starRepos,
      commits: [],
      pullRequests: [],
      issues: [],
      contributions: {
        totalCommitContributions: 5,
        totalPullRequestContributions: 0,
        totalIssueContributions: 0,
        totalRepositoryContributions: 0,
        contributionMonths: [{ year: 2026, month: 1, count: 5 }],
      },
    });
    const mismatch = computeAuthenticitySignals(input).find(
      (s) => s.code === SIGNAL_CODES.STAR_ACTIVITY_MISMATCH,
    );
    expect(mismatch?.severity).toBe('risk');
    expectValidRefs(input);
  });

  it('flags stale activity after more than a year of silence', () => {
    const staleRepos: AnalyzerRepo[] = [
      {
        name: 'old-repo',
        ownerLogin: 'dev-strong',
        url: 'https://github.com/dev-strong/old-repo',
        isFork: false,
        isArchived: false,
        primaryLanguage: 'TypeScript',
        topics: [],
        description: null,
        stargazerCount: 10,
        forkCount: 0,
        pushedAt: '2024-08-01T00:00:00Z',
        createdAt: '2022-01-01T00:00:00Z',
      },
    ];
    const input = buildInput({ repos: staleRepos, commits: [], pullRequests: [], issues: [] });
    const stale = computeAuthenticitySignals(input).find(
      (s) => s.code === SIGNAL_CODES.STALE_ACTIVITY,
    );
    expect(stale?.severity).toBe('warn');
    expectValidRefs(input);
  });
});

describe('narrow activity scope (rule 0.2, plan B)', () => {
  const narrowRepo: AnalyzerRepo = {
    name: 'only-repo',
    ownerLogin: 'dev-strong',
    url: 'https://github.com/dev-strong/only-repo',
    isFork: false,
    isArchived: false,
    primaryLanguage: 'TypeScript',
    topics: [],
    description: null,
    stargazerCount: 5,
    forkCount: 0,
    pushedAt: '2026-08-20T00:00:00Z',
    createdAt: '2024-01-01T00:00:00Z',
  };
  // 分布在 2026-01..09 各月，避免触发 commit_burst；默认全部落在同一仓库
  const singleRepoCommits = (n: number, repo = 'dev-strong/only-repo'): AnalyzerCommit[] =>
    Array.from({ length: n }, (_, i) => ({
      oid: `nr${String(i).padStart(3, '0')}${'0'.repeat(34)}`,
      committedAt: `2026-0${(i % 9) + 1}-15T10:00:00Z`,
      authorName: 'Dev Strong',
      authorEmail: 'dev.strong@example.com',
      repoName: repo,
      messageHeadline: `commit ${i}`,
    }));
  const narrowEvents = {
    totalEvents: 20,
    distinctRepoCount: 1,
    eventTypeCounts: { PushEvent: 20 },
  };
  const base = {
    repos: [narrowRepo],
    commits: singleRepoCommits(40),
    pullRequests: [],
    issues: [],
  };

  it('warns when commits concentrate in one repo, no PRs and events are narrow too', () => {
    const input = buildInput({ ...base, behaviorEvents: narrowEvents });
    const narrow = computeAuthenticitySignals(input).find(
      (s) => s.code === SIGNAL_CODES.NARROW_ACTIVITY_SCOPE,
    );
    expect(narrow?.severity).toBe('warn');
    expectValidRefs(input);
  });

  it('still warns via structural fallback when behaviorEvents is missing', () => {
    const input = buildInput(base);
    const narrow = computeAuthenticitySignals(input).find(
      (s) => s.code === SIGNAL_CODES.NARROW_ACTIVITY_SCOPE,
    );
    expect(narrow?.severity).toBe('warn');
  });

  it('is refuted by events spanning multiple repos (sampling bias)', () => {
    const input = buildInput({
      ...base,
      behaviorEvents: { totalEvents: 20, distinctRepoCount: 3, eventTypeCounts: { PushEvent: 20 } },
    });
    expect(
      computeAuthenticitySignals(input).some((s) => s.code === SIGNAL_CODES.NARROW_ACTIVITY_SCOPE),
    ).toBe(false);
  });

  it('is refuted by collaborative event types (PR/Issue/Review/Comment)', () => {
    const input = buildInput({
      ...base,
      behaviorEvents: {
        totalEvents: 20,
        distinctRepoCount: 1,
        eventTypeCounts: { PushEvent: 18, PullRequestEvent: 2 },
      },
    });
    expect(
      computeAuthenticitySignals(input).some((s) => s.code === SIGNAL_CODES.NARROW_ACTIVITY_SCOPE),
    ).toBe(false);
  });

  it('is exempted by an externally merged PR', () => {
    // buildInput 默认 PR 中含 other-org 的 merged PR（外部协作）
    const input = buildInput({
      ...base,
      pullRequests: [
        {
          number: 9,
          title: 'upstream fix',
          url: 'https://github.com/other-org/lib/pull/9',
          state: 'MERGED' as const,
          createdAt: '2026-06-01T08:00:00Z',
          mergedAt: '2026-06-03T08:00:00Z',
          repoNameWithOwner: 'other-org/lib',
          repoIsFork: false,
          repoOwnerIsSelf: false,
          additions: 12,
          deletions: 3,
          changedFiles: 2,
        },
      ],
      behaviorEvents: narrowEvents,
    });
    expect(
      computeAuthenticitySignals(input).some((s) => s.code === SIGNAL_CODES.NARROW_ACTIVITY_SCOPE),
    ).toBe(false);
  });

  it('does not trigger below the behavior-total floor', () => {
    const input = buildInput({
      ...base,
      commits: singleRepoCommits(10),
      behaviorEvents: narrowEvents,
    });
    expect(
      computeAuthenticitySignals(input).some((s) => s.code === SIGNAL_CODES.NARROW_ACTIVITY_SCOPE),
    ).toBe(false);
  });

  it('does not trigger when commits span multiple repos', () => {
    const input = buildInput({
      repos: [
        narrowRepo,
        { ...narrowRepo, name: 'second', url: 'https://github.com/dev-strong/second' },
      ],
      commits: [
        ...singleRepoCommits(20, 'dev-strong/only-repo'),
        ...singleRepoCommits(20, 'dev-strong/second'),
      ],
      pullRequests: [],
      issues: [],
      behaviorEvents: narrowEvents,
    });
    expect(
      computeAuthenticitySignals(input).some((s) => s.code === SIGNAL_CODES.NARROW_ACTIVITY_SCOPE),
    ).toBe(false);
  });
});

describe('activity metrics behavior-event fields (plan B-1)', () => {
  it('exposes commitRepoCount always and event* metrics only with behaviorEvents', () => {
    const input0 = buildInput({});
    const base = computeActivity(input0, computeAuthenticitySignals(input0));
    expect(base.metrics!.commitRepoCount).toBeGreaterThanOrEqual(1);
    expect(base.metrics).not.toHaveProperty('eventTotalEvents');

    const input1 = buildInput({
      behaviorEvents: {
        totalEvents: 12,
        distinctRepoCount: 3,
        eventTypeCounts: { PushEvent: 10, IssuesEvent: 2 },
      },
    });
    const withEvents = computeActivity(input1, computeAuthenticitySignals(input1));
    expect(withEvents.metrics!.eventTotalEvents).toBe(12);
    expect(withEvents.metrics!.eventDistinctRepos).toBe(3);
    expect(withEvents.metrics!.eventTypeKinds).toBe(2);
  });
});

describe('computeAuthenticity (status & confidence)', () => {
  it('strong account → likely_authentic with confidence >= 0.8', () => {
    const { status, confidence } = computeAuthenticity(buildInput());
    expect(status).toBe('likely_authentic');
    expect(confidence).toBeGreaterThanOrEqual(0.8);
  });

  it('email-only mismatch stays likely_authentic with a warn signal', () => {
    const { status, signals } = computeAuthenticity(buildInput({ email: 'other@example.com' }));
    expect(status).toBe('likely_authentic');
    expect(signals.some((s) => s.code === SIGNAL_CODES.AUTHOR_INCONSISTENCY)).toBe(true);
  });

  it('double identity mismatch (email + name) → suspicious', () => {
    const mismatchedCommits: AnalyzerCommit[] = Array.from({ length: 3 }, (_, i) => ({
      oid: `dmm${String(i + 1).padStart(2, '0')}${'0'.repeat(35)}`,
      committedAt: `2026-0${i + 1}-15T10:00:00Z`,
      authorName: 'Someone Else',
      authorEmail: 'someone.else@example.com',
      repoName: 'dev-strong/web-platform',
      messageHeadline: `mismatched ${i}`,
    }));
        const { status: doubleStatus } = computeAuthenticity(
      buildInput({
        email: 'other@example.com',
        commits: mismatchedCommits,
        pullRequests: [], // no external contributions so author risk is not mitigated
      }),
    );
    expect(doubleStatus).toBe('suspicious');
  });

  it('near-empty account → insufficient_data with fixed low confidence', () => {
    const { status, confidence, signals } = computeAuthenticity(
      buildInput({
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
      }),
    );
    expect(status).toBe('insufficient_data');
    expect(confidence).toBe(0.35);
    expect(signals.some((s) => s.code === SIGNAL_CODES.EMPTY_ACTIVITY)).toBe(true);
  });

  it('two warns without positive signals → mixed_signals', () => {
    const staleRepos: AnalyzerRepo[] = [
      {
        name: 'old-repo',
        ownerLogin: 'dev-strong',
        url: 'https://github.com/dev-strong/old-repo',
        isFork: false,
        isArchived: false,
        primaryLanguage: 'TypeScript',
        topics: [],
        description: null,
        stargazerCount: 600,
        forkCount: 2,
        pushedAt: '2024-08-01T00:00:00Z',
        createdAt: '2022-01-01T00:00:00Z',
      },
    ];
    const input = buildInput({
      repos: staleRepos,
      commits: [],
      pullRequests: [],
      issues: [],
      contributions: {
        totalCommitContributions: 20,
        totalPullRequestContributions: 0,
        totalIssueContributions: 0,
        totalRepositoryContributions: 0,
        contributionMonths: [],
      },
    });
    const { status } = computeAuthenticity(input);
    expect(status).toBe('mixed_signals');
  });

  it('self_pr_ratio alone (single warn) → mixed_signals', () => {
    const selfPRs: AnalyzerPullRequest[] = Array.from({ length: 25 }, (_, i) => ({
      number: i + 1,
      title: `self PR ${i + 1}`,
      url: `https://github.com/dev-strong/repo-${i % 5}/pull/${i + 1}`,
      state: 'MERGED' as const,
      createdAt: `2026-0${(i % 9) + 1}-15T10:00:00Z`,
      mergedAt: `2026-0${(i % 9) + 1}-16T10:00:00Z`,
      repoNameWithOwner: `dev-strong/repo-${i % 5}`,
      repoIsFork: false,
      repoOwnerIsSelf: true,
      additions: 10,
      deletions: 2,
      changedFiles: 1,
    }));
    const { status } = computeAuthenticity(buildInput({ pullRequests: selfPRs, issues: [] }));
    expect(status).toBe('mixed_signals');
  });

  it('self_pr_ratio is mitigated by an external merged PR (stays likely_authentic)', () => {
    const selfPRs: AnalyzerPullRequest[] = Array.from({ length: 25 }, (_, i) => ({
      number: i + 1,
      title: `self PR ${i + 1}`,
      url: `https://github.com/dev-strong/repo-${i % 5}/pull/${i + 1}`,
      state: 'MERGED' as const,
      createdAt: `2026-0${(i % 9) + 1}-15T10:00:00Z`,
      mergedAt: `2026-0${(i % 9) + 1}-16T10:00:00Z`,
      repoNameWithOwner: `dev-strong/repo-${i % 5}`,
      repoIsFork: false,
      repoOwnerIsSelf: true,
      additions: 10,
      deletions: 2,
      changedFiles: 1,
    }));
    const extPR: AnalyzerPullRequest = {
      number: 1,
      title: 'external contribution',
      url: 'https://github.com/other-org/project/pull/1',
      state: 'MERGED' as const,
      createdAt: '2026-06-15T08:00:00Z',
      mergedAt: '2026-06-20T12:00:00Z',
      repoNameWithOwner: 'other-org/project',
      repoIsFork: false,
      repoOwnerIsSelf: false,
      additions: 50,
      deletions: 10,
      changedFiles: 3,
    };
    const { status } = computeAuthenticity(
      buildInput({ pullRequests: [...selfPRs, extPR], issues: [] }),
    );
    expect(status).toBe('likely_authentic');
  });


  it('external contributions mitigate author inconsistency risk', () => {
    const mismatchedCommits: AnalyzerCommit[] = Array.from({ length: 3 }, (_, i) => ({
      oid: `ext${String(i + 1).padStart(2, '0')}${'0'.repeat(35)}`,
      committedAt: `2026-0${i + 1}-15T10:00:00Z`,
      authorName: 'Someone Else',
      authorEmail: 'someone.else@example.com',
      repoName: 'dev-strong/web-platform',
      messageHeadline: `mismatched ${i}`,
    }));
    // 默认 buildInput 有外部 merged PR（other-org/awesome-project）
    const signals = computeAuthenticitySignals(
      buildInput({ email: 'other@example.com', commits: mismatchedCommits }),
    );
    const author = signals.find((s) => s.code === SIGNAL_CODES.AUTHOR_INCONSISTENCY);
    // 有外部贡献时，risk 降级为 warn
    expect(author?.severity).toBe('warn');
    expect(author?.detail).toContain('mitigated by verified external contributions');
  });

  it('external contributions prevent suspicious status for double identity mismatch', () => {
    const mismatchedCommits: AnalyzerCommit[] = Array.from({ length: 3 }, (_, i) => ({
      oid: `st${String(i + 1).padStart(2, '0')}${'0'.repeat(35)}`,
      committedAt: `2026-0${i + 1}-15T10:00:00Z`,
      authorName: 'Someone Else',
      authorEmail: 'someone.else@example.com',
      repoName: 'dev-strong/web-platform',
      messageHeadline: `mismatched ${i}`,
    }));
    // 默认有外部 PR，不应被判为 suspicious
    const { status } = computeAuthenticity(
      buildInput({ email: 'other@example.com', commits: mismatchedCommits }),
    );
    expect(status).not.toBe('suspicious');
  });

  it('confidence stays within [0.3, 0.95] and is rounded to 2 decimals', () => {
    const { confidence } = computeAuthenticity(buildInput({ email: 'other@example.com' }));
    expect(confidence).toBeGreaterThanOrEqual(0.3);
    expect(confidence).toBeLessThanOrEqual(0.95);
    expect(Number.isInteger(confidence * 100)).toBe(true);
  });

  it('flags star_to_commit_ratio warn when stars disproportionately exceed commits', () => {
    const starRepos: AnalyzerRepo[] = [
      {
        name: 'popular-repo',
        ownerLogin: 'dev-strong',
        url: 'https://github.com/dev-strong/popular-repo',
        isFork: false,
        isArchived: false,
        primaryLanguage: 'TypeScript',
        topics: [],
        description: null,
        stargazerCount: 800,
        forkCount: 100,
        pushedAt: '2026-08-01T00:00:00Z',
        createdAt: '2024-01-01T00:00:00Z',
      },
    ];
    const fewCommits: AnalyzerCommit[] = [
      {
        oid: 'sc01bb02cc03dd04ee05ff06aa07bb08cc09dd0e',
        committedAt: '2026-07-15T10:00:00Z',
        authorName: 'Dev Strong',
        authorEmail: 'dev.strong@example.com',
        repoName: 'dev-strong/popular-repo',
        messageHeadline: 'initial commit',
      },
    ];
    const signals = computeAuthenticitySignals(
      buildInput({ repos: starRepos, commits: fewCommits, pullRequests: [], issues: [] }),
    );
    const ratio = signals.find((s) => s.code === SIGNAL_CODES.STAR_TO_COMMIT_RATIO);
    expect(ratio?.severity).toBe('warn');
    expect(ratio?.detail).toContain('ratio');
    expectValidRefs(buildInput({ repos: starRepos, commits: fewCommits }));
  });

  it('elevates extreme star-to-commit ratio (>=2000 stars, >=50:1) to risk and overall suspicious', () => {
    // 复现负样本 MSNightmare：约 5k star、仅 33 个采样 commit、0 PR、窗口短
    const viralRepos: AnalyzerRepo[] = [
      {
        name: 'viral-repo',
        ownerLogin: 'dev-strong',
        url: 'https://github.com/dev-strong/viral-repo',
        isFork: false,
        isArchived: false,
        primaryLanguage: 'JavaScript',
        topics: [],
        description: null,
        stargazerCount: 4971,
        forkCount: 1646,
        pushedAt: '2026-08-01T00:00:00Z',
        createdAt: '2026-06-01T00:00:00Z',
      },
    ];
    const fewCommits: AnalyzerCommit[] = Array.from({ length: 33 }, (_, i) => ({
      oid: `ec${String(i).padStart(38, '0')}`,
      committedAt: '2026-07-15T10:00:00Z',
      authorName: 'Dev Strong',
      authorEmail: 'dev.strong@example.com',
      repoName: 'dev-strong/viral-repo',
      messageHeadline: `commit ${i}`,
    }));
    const { status, signals } = computeAuthenticity(
      buildInput({ repos: viralRepos, commits: fewCommits, pullRequests: [], issues: [] }),
    );
    const ratio = signals.find((s) => s.code === SIGNAL_CODES.STAR_TO_COMMIT_RATIO);
    expect(ratio?.severity).toBe('risk');
    expect(status).toBe('suspicious');
  });

  it('mitigates extreme star-to-commit ratio risk when the account has externally merged PRs', () => {
    // 高声望维护者：项目 star 极高、本人采样 commit 少，但有被外部项目 merge 的 PR，
    // 难以伪造的协作证据应抵消 ratio risk（区别于 0 外部 PR 的买 star 账号）。
    const viralRepos: AnalyzerRepo[] = [
      {
        name: 'framework',
        ownerLogin: 'dev-strong',
        url: 'https://github.com/dev-strong/framework',
        isFork: false,
        isArchived: false,
        primaryLanguage: 'Ruby',
        topics: [],
        description: null,
        stargazerCount: 50000,
        forkCount: 12000,
        pushedAt: '2026-08-01T00:00:00Z',
        createdAt: '2020-01-01T00:00:00Z',
      },
    ];
    const fewCommits: AnalyzerCommit[] = Array.from({ length: 40 }, (_, i) => ({
      oid: `mx${String(i).padStart(38, '0')}`,
      committedAt: '2026-07-15T10:00:00Z',
      authorName: 'Dev Strong',
      authorEmail: 'dev.strong@example.com',
      repoName: 'dev-strong/framework',
      messageHeadline: `commit ${i}`,
    }));
    const extPRs: AnalyzerPullRequest[] = [
      {
        number: 7,
        title: 'upstream fix merged elsewhere',
        url: 'https://github.com/other-org/stack/pull/7',
        state: 'MERGED' as const,
        createdAt: '2026-07-01T08:00:00Z',
        mergedAt: '2026-07-03T12:00:00Z',
        repoNameWithOwner: 'other-org/stack',
        repoIsFork: false,
        repoOwnerIsSelf: false,
        additions: 30,
        deletions: 8,
        changedFiles: 2,
      },
    ];
    const { status, signals } = computeAuthenticity(
      buildInput({ repos: viralRepos, commits: fewCommits, pullRequests: extPRs, issues: [] }),
    );
    const ratio = signals.find((s) => s.code === SIGNAL_CODES.STAR_TO_COMMIT_RATIO);
    expect(ratio?.severity).toBe('warn');
    expect(status).not.toBe('suspicious');
  });

  it('treats extreme ratio of a long-lived maintainer as warn rather than risk (wycats case)', () => {
    // 组织核心维护者：5w+ star、个人采样 commit 少、PR 多在自己是成员的组织仓库，
    // 但账号活跃多年、merged PR 多、行为总量大——不应判 suspicious。
    const bigRepos: AnalyzerRepo[] = [
      {
        name: 'framework',
        ownerLogin: 'dev-strong',
        url: 'https://github.com/dev-strong/framework',
        isFork: false,
        isArchived: false,
        primaryLanguage: 'JavaScript',
        topics: [],
        description: null,
        stargazerCount: 53011,
        forkCount: 6564,
        pushedAt: '2026-08-01T00:00:00Z',
        createdAt: '2019-01-01T00:00:00Z',
      },
    ];
    // 283 个近期 commit + 1 个 2020 年的早期 commit，把活动跨度拉到 6 年以上
    const commits: AnalyzerCommit[] = [
      ...Array.from({ length: 283 }, (_, i) => ({
        oid: `lf${String(i).padStart(38, '0')}`,
        committedAt: '2026-08-01T10:00:00Z',
        authorName: 'Dev Strong',
        authorEmail: 'dev.strong@example.com',
        repoName: 'dev-strong/framework',
        messageHeadline: `c ${i}`,
      })),
      {
        oid: 'lf0000000000000000000000000000000000old',
        committedAt: '2020-03-01T10:00:00Z',
        authorName: 'Dev Strong',
        authorEmail: 'dev.strong@example.com',
        repoName: 'dev-strong/framework',
        messageHeadline: 'early commit',
      },
    ];
    const selfPRs: AnalyzerPullRequest[] = Array.from({ length: 47 }, (_, i) => ({
      number: i + 1,
      title: `self merged PR ${i + 1}`,
      url: `https://github.com/dev-strong/framework/pull/${i + 1}`,
      state: 'MERGED' as const,
      createdAt: '2026-07-01T08:00:00Z',
      mergedAt: '2026-07-02T08:00:00Z',
      repoNameWithOwner: 'dev-strong/framework',
      repoIsFork: false,
      repoOwnerIsSelf: true,
      additions: 10,
      deletions: 2,
      changedFiles: 1,
    }));
    const { status, signals } = computeAuthenticity(
      buildInput({ repos: bigRepos, commits, pullRequests: selfPRs, issues: [] }),
    );
    const ratioSignal = signals.find((s) => s.code === SIGNAL_CODES.STAR_TO_COMMIT_RATIO);
    expect(ratioSignal?.severity).toBe('warn');
    expect(status).not.toBe('suspicious');
  });

  it('downgrades short-window thin evidence to mixed_signals even with one weak external PR', () => {
    // 复现负样本 ByteBunny777：少量活动、窗口仅 1-3 个月、仅 1 个外部 merged PR，
    // 不应给 likely_authentic 高置信度结论。
    const recentCommits: AnalyzerCommit[] = Array.from({ length: 38 }, (_, i) => ({
      oid: `tb${String(i).padStart(38, '0')}`,
      committedAt: '2026-08-10T10:00:00Z',
      authorName: 'Dev Strong',
      authorEmail: 'dev.strong@example.com',
      repoName: 'dev-strong/web-platform',
      messageHeadline: `commit ${i}`,
    }));
    // 仓库也都是近期的（窗口约 1 个月），避免默认仓库的历史 pushedAt 拉长窗口
    const recentRepos: AnalyzerRepo[] = [
      {
        name: 'web-platform',
        ownerLogin: 'dev-strong',
        url: 'https://github.com/dev-strong/web-platform',
        isFork: false,
        isArchived: false,
        primaryLanguage: 'TypeScript',
        topics: [],
        description: null,
        stargazerCount: 262,
        forkCount: 6,
        pushedAt: '2026-08-20T00:00:00Z',
        createdAt: '2026-07-01T00:00:00Z',
      },
    ];
    const oneExtPR: AnalyzerPullRequest[] = [
      {
        number: 1,
        title: 'single external contribution',
        url: 'https://github.com/other-org/project/pull/1',
        state: 'MERGED' as const,
        createdAt: '2026-08-12T08:00:00Z',
        mergedAt: '2026-08-14T12:00:00Z',
        repoNameWithOwner: 'other-org/project',
        repoIsFork: false,
        repoOwnerIsSelf: false,
        additions: 20,
        deletions: 5,
        changedFiles: 2,
      },
    ];
    const { status, confidence } = computeAuthenticity(
      buildInput({
        repos: recentRepos,
        commits: recentCommits,
        pullRequests: oneExtPR,
        issues: [],
      }),
    );
    expect(status).toBe('mixed_signals');
    expect(confidence).toBeLessThanOrEqual(0.6);
  });

  it('flags self_pr_ratio warn when nearly all PRs are in self-owned repos', () => {
    const selfPRs: AnalyzerPullRequest[] = Array.from({ length: 25 }, (_, i) => ({
      number: i + 1,
      title: `self PR ${i + 1}`,
      url: `https://github.com/dev-strong/repo-${i % 5}/pull/${i + 1}`,
      state: 'MERGED' as const,
      createdAt: `2026-0${(i % 9) + 1}-15T10:00:00Z`,
      mergedAt: `2026-0${(i % 9) + 1}-16T10:00:00Z`,
      repoNameWithOwner: `dev-strong/repo-${i % 5}`,
      repoIsFork: false,
      repoOwnerIsSelf: true,
      additions: 10,
      deletions: 2,
      changedFiles: 1,
    }));
    const signals = computeAuthenticitySignals(buildInput({ pullRequests: selfPRs }));
    const selfRatio = signals.find((s) => s.code === SIGNAL_CODES.SELF_PR_RATIO);
    expect(selfRatio?.severity).toBe('warn');
    expect(selfRatio?.detail).toContain('self-owned repos');
  });

  it('weak external contributions (1-2 PRs) add less confidence than strong (3+)', () => {
    const oneExtPR: AnalyzerPullRequest[] = [
      {
        number: 1,
        title: 'single external contribution',
        url: 'https://github.com/other-org/project/pull/1',
        state: 'MERGED' as const,
        createdAt: '2026-06-15T08:00:00Z',
        mergedAt: '2026-06-20T12:00:00Z',
        repoNameWithOwner: 'other-org/project',
        repoIsFork: false,
        repoOwnerIsSelf: false,
        additions: 50,
        deletions: 10,
        changedFiles: 3,
      },
    ];
    const threeExtPRs: AnalyzerPullRequest[] = Array.from({ length: 3 }, (_, i) => ({
      number: i + 1,
      title: `external contribution ${i + 1}`,
      url: `https://github.com/other-org/project-${i}/pull/${i + 1}`,
      state: 'MERGED' as const,
      createdAt: `2026-0${i + 4}-15T08:00:00Z`,
      mergedAt: `2026-0${i + 4}-20T12:00:00Z`,
      repoNameWithOwner: `other-org/project-${i}`,
      repoIsFork: false,
      repoOwnerIsSelf: false,
      additions: 50,
      deletions: 10,
      changedFiles: 3,
    }));
    const weak = computeAuthenticity(buildInput({ pullRequests: oneExtPR, commits: [] }));
    const strong = computeAuthenticity(buildInput({ pullRequests: threeExtPRs, commits: [] }));
    // 弱正向 +0.05，强正向 +0.1，所以 strong confidence 应该比 weak 高 0.05
    expect(strong.confidence).toBeGreaterThan(weak.confidence);
    expect(weak.signals.find((s) => s.code === SIGNAL_CODES.EXTERNAL_CONTRIBUTIONS)?.detail).toContain('weak positive signal');
    expect(strong.signals.find((s) => s.code === SIGNAL_CODES.EXTERNAL_CONTRIBUTIONS)?.detail).toContain('strong positive signal');
  });
});

describe('adversarial and boundary negative samples (rule 0.3)', () => {
  function forkRepo(name: string, stars: number, ownerLogin = 'fork-farm'): AnalyzerRepo {
    return {
      name,
      ownerLogin,
      url: `https://github.com/${ownerLogin}/${name}`,
      isFork: true,
      isArchived: false,
      primaryLanguage: 'JavaScript',
      topics: [],
      description: null,
      stargazerCount: stars,
      forkCount: 0,
      pushedAt: '2026-08-01T00:00:00Z',
      createdAt: '2026-05-01T00:00:00Z',
    };
  }

  it('rates a pure-fork mirror with no own behavior as insufficient_data', () => {
    const input = buildInput({
      login: 'fork-farm',
      repos: [forkRepo('famous-a', 300), forkRepo('famous-b', 100)],
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
    const result = computeAuthenticity(input);
    expect(result.status).toBe('insufficient_data');
    expect(result.confidence).toBe(0.35);
    expect(result.signals.some((s) => s.code === SIGNAL_CODES.EMPTY_ACTIVITY)).toBe(true);
  });

  it('rates a completely empty timeline as insufficient_data', () => {
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
    const result = computeAuthenticity(input);
    expect(result.status).toBe('insufficient_data');
    expectValidRefs(input);
  });

  it('pins the 2000-star boundary for star-activity mismatch', () => {
    const below = buildInput({
      repos: [
        {
          ...forkRepo('repo', 1999, 'dev-strong'),
          isFork: false,
        },
      ],
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
    expect(
      computeAuthenticitySignals(below).some(
        (s) => s.code === SIGNAL_CODES.STAR_ACTIVITY_MISMATCH && s.severity === 'risk',
      ),
    ).toBe(false);

    const atBoundary = buildInput({
      repos: [
        {
          ...forkRepo('repo', 2000, 'dev-strong'),
          isFork: false,
        },
      ],
      commits: [],
      pullRequests: [],
      issues: [],
      contributions: {
        totalCommitContributions: 5,
        totalPullRequestContributions: 0,
        totalIssueContributions: 0,
        totalRepositoryContributions: 0,
        contributionMonths: [],
      },
    });
    expect(
      computeAuthenticitySignals(atBoundary).some(
        (s) => s.code === SIGNAL_CODES.STAR_ACTIVITY_MISMATCH && s.severity === 'risk',
      ),
    ).toBe(true);
  });

  it('pins the 50:1 star-to-commit boundary for a short unestablished account', () => {
    function ratioInput(commitCount: number): AnalyzerInput {
      const commits: AnalyzerCommit[] = Array.from({ length: commitCount }, (_, i) => ({
        oid: `b0000000000000000000000000000000000000${String(i).padStart(3, '0')}`,
        committedAt: '2026-07-15T10:00:00Z',
        authorName: 'Dev Strong',
        authorEmail: 'dev.strong@example.com',
        repoName: 'dev-strong/repo',
        messageHeadline: `commit ${i + 1}`,
      }));
      return buildInput({
        repos: [
          {
            ...forkRepo('repo', 2000, 'dev-strong'),
            isFork: false,
          },
        ],
        commits,
        pullRequests: [],
        issues: [],
        contributions: {
          totalCommitContributions: commitCount,
          totalPullRequestContributions: 0,
          totalIssueContributions: 0,
          totalRepositoryContributions: 0,
          contributionMonths: [],
        },
      });
    }

    // 2000 stars / 41 commits ≈ 48.8:1：未达极端阈值
    expect(
      computeAuthenticitySignals(ratioInput(41)).some(
        (s) => s.code === SIGNAL_CODES.STAR_TO_COMMIT_RATIO,
      ),
    ).toBe(false);
    // 2000 stars / 40 commits 恰好 50:1：raw extreme，短历史无协作 → risk
    const atBoundary = computeAuthenticity(ratioInput(40));
    expect(
      atBoundary.signals.some(
        (s) => s.code === SIGNAL_CODES.STAR_TO_COMMIT_RATIO && s.severity === 'risk',
      ),
    ).toBe(true);
    expect(atBoundary.status).toBe('suspicious');
  });
});
