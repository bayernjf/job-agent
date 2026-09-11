import { describe, expect, it } from 'vitest';
import { computeAuthenticity, computeAuthenticitySignals } from './signals.js';
import { SIGNAL_CODES } from './rules.js';
import { buildInput } from './test-input.js';
import type { AnalyzerCommit, AnalyzerInput, AnalyzerRepo } from './input.js';

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
});
