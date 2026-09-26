import { describe, expect, it } from 'vitest';
import {
  AbilityProfileSchema,
  parseAbilityProfile,
  SCHEMA_VERSION,
  matchScoreTier,
  composeSignalLabel,
  composeSignalDetail,
  composeInterviewIntent,
  composeCadenceSummary,
  composePrSummary,
  prSummaryFactsFromProfile,
  type AbilityProfile,
  type MatchScoreTier,
} from './index.js';

/** 构造一份最小合法画像（含 L0/L1 各一个证据） */
function validProfile(): AbilityProfile {
  return {
    profileId: 'prof_01J000000000000000000000',
    analyzerVersion: `schema-${SCHEMA_VERSION}-engine-0.1.0`,
    generatedAt: '2026-09-10T00:00:00.000Z',
    dataWindow: {
      since: '2025-09-10T00:00:00.000Z',
      until: '2026-09-10T00:00:00.000Z',
    },
    analysisLayers: ['L0', 'L1'],
    subject: {
      platform: 'github',
      login: 'linxiaoman',
      profileUrl: 'https://github.com/linxiaoman',
      claimed: false,
    },
    summary: {
      headline: '全栈工程师，14 个月长线投入',
    },
    skillTags: [
      {
        name: 'TypeScript',
        kind: 'language',
        depth: 'proficient',
        confidence: 0.9,
        evidenceRefs: ['ev_commit_1'],
      },
    ],
    activity: {
      longevityMonths: 14,
      metrics: { publicRepos: 12, followers: 30 },
    },
    collaboration: {
      externalMergedContributions: ['https://github.com/other/repo/pull/42'],
      evidenceRefs: ['ev_pr_1'],
    },
    authenticity: {
      status: 'likely_authentic',
      confidence: 0.82, // 置信度而非"真实度百分比"
      signals: [
        {
          code: 'signal.commit-spread.v1',
          severity: 'info',
          label: '提交时间分布合理',
          detail: 'commit 分散在 14 个月，非批量灌水模式',
          evidenceRefs: ['ev_commit_1'],
        },
      ],
    },
    interviewQuestions: [
      {
        question: '解释 job-agent 仓库中 auth 模块的演进原因',
        intent: '验证对自身项目的理解深度',
        basisEvidenceRef: 'ev_commit_1',
      },
    ],
    caveats: ['未获得本人认领，部分结论基于公开数据'],
  };
}

describe('AbilityProfileSchema', () => {
  it('accepts a minimal valid profile', () => {
    expect(AbilityProfileSchema.safeParse(validProfile()).success).toBe(true);
  });

  it('rejects a profile missing a required field', () => {
    const bad = validProfile();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (bad as any).profileId;
    expect(AbilityProfileSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects an unknown authenticity status', () => {
    const bad = validProfile();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (bad.authenticity as any).status = '80%';
    expect(AbilityProfileSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a confidence outside 0-1', () => {
    const bad = validProfile();
    bad.authenticity.confidence = 1.5;
    expect(AbilityProfileSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects an invalid evidence URL', () => {
    const bad = validProfile();
    bad.skillTags[0]!.evidenceRefs = ['not-a-real-evidence-id'];
    // evidenceRefs 只校验非空字符串，此处验证的是必填结构而非引用存在性
    expect(AbilityProfileSchema.safeParse(bad).success).toBe(true);
  });

  it('parseAbilityProfile returns null on invalid input', () => {
    expect(parseAbilityProfile({ nope: true })).toBeNull();
    expect(parseAbilityProfile(validProfile())).not.toBeNull();
  });

  it('accepts gitee as a subject platform', () => {
    const p = validProfile();
    p.subject.platform = 'gitee';
    expect(AbilityProfileSchema.safeParse(p).success).toBe(true);
  });

  it('accepts an optional cross-source fusion report', () => {
    const p = validProfile();
    p.fusion = {
      primaryPlatform: 'github',
      secondaryPlatform: 'gitee',
      mergedMirrors: [{ primaryRef: 'o/r', secondaryRef: 'o/r', sharedOidCount: 3 }],
      suspectedMirrors: [],
      dedupedCommitCount: 2,
      dedupedPullRequestCount: 1,
      dedupedIssueCount: 0,
      keptSecondaryRepoRefs: ['o/extra'],
      counts: {
        primaryRepos: 1,
        secondaryRepos: 2,
        fusedRepos: 2,
        primaryCommits: 10,
        secondaryCommits: 8,
        fusedCommits: 16,
        primaryPullRequests: 2,
        secondaryPullRequests: 2,
        fusedPullRequests: 3,
        primaryIssues: 1,
        secondaryIssues: 1,
        fusedIssues: 1,
      },
    };
    const parsed = AbilityProfileSchema.parse(p);
    expect(parsed.fusion?.dedupedPullRequestCount).toBe(1);
    expect(parsed.fusion?.mergedMirrors).toHaveLength(1);
  });

  it('has no fusion section on a single-source profile', () => {
    expect(AbilityProfileSchema.parse(validProfile()).fusion).toBeUndefined();
  });

  it('exposes the schema version', () => {
    expect(SCHEMA_VERSION).toBe('0.1');
  });
});

describe('matchScoreTier', () => {
  it('returns high when score >= 80% of max', () => {
    expect(matchScoreTier(5, 1)).toBe<MatchScoreTier>('high'); // 5/6 = 83%
    expect(matchScoreTier(10, 2)).toBe<MatchScoreTier>('high'); // 10/12 = 83%
  });

  it('returns mid when score >= 40% but < 80%', () => {
    expect(matchScoreTier(3, 1)).toBe<MatchScoreTier>('mid'); // 3/6 = 50%
    expect(matchScoreTier(5, 2)).toBe<MatchScoreTier>('mid'); // 5/12 = 42%
  });

  it('returns low when score < 40%', () => {
    expect(matchScoreTier(2, 1)).toBe<MatchScoreTier>('low'); // 2/6 = 33%
    expect(matchScoreTier(5, 3)).toBe<MatchScoreTier>('low'); // 5/18 = 28%
  });

  it('returns low for zero matched skills regardless of score', () => {
    expect(matchScoreTier(0, 0)).toBe<MatchScoreTier>('low');
    expect(matchScoreTier(9, 0)).toBe<MatchScoreTier>('low');
  });

  it('uses ratio so multi-skill profiles are not misjudged by absolute threshold', () => {
    // 5 skills, score 6 = only 20% -> low (old absolute rule >=6 would wrongly say high)
    expect(matchScoreTier(6, 5)).toBe<MatchScoreTier>('low');
    // 3 skills, score 15 = 83% -> high (old absolute rule also high, but ratio is fair)
    expect(matchScoreTier(15, 3)).toBe<MatchScoreTier>('high');
  });
});


describe('T33 composers (facts + code driven)', () => {
  it('composeSignalLabel returns localized titles for known codes', () => {
    expect(composeSignalLabel('r0.1.sig.commit_burst', 'zh-CN', 'fallback')).toBe('提交突发且前后长期沉默');
    expect(composeSignalLabel('r0.1.sig.commit_burst', 'en', 'fallback')).toBe('Commit burst followed by long silence');
  });

  it('composeSignalLabel falls back to the snapshot English label for unknown codes', () => {
    expect(composeSignalLabel('external_contributions', 'zh-CN', 'External PRs merged')).toBe('External PRs merged');
    expect(composeSignalLabel('r9.9.sig.unknown', 'en', 'Raw snapshot sentence')).toBe('Raw snapshot sentence');
  });

  it('composeSignalDetail composes from facts and falls back to the snapshot sentence', () => {
    const detail = composeSignalDetail(
      'r0.1.sig.stale_activity',
      'zh-CN',
      'Latest GitHub activity was 30 months ago',
      { monthsAgo: 30 },
    );
    expect(detail).toBe('最近的 GitHub 活动在 30 个月前');
    // 缺 facts 时退回快照英文原句，不猜数
    expect(composeSignalDetail('r0.1.sig.stale_activity', 'zh-CN', 'Latest GitHub activity was 30 months ago')).toBe(
      'Latest GitHub activity was 30 months ago',
    );
  });

  it('composeInterviewIntent returns the intent copy per kind and falls back otherwise', () => {
    expect(composeInterviewIntent('external_pr', 'zh-CN', 'fallback')).toBe('考察在外部代码库中的协作能力与工程判断');
    expect(composeInterviewIntent('external_pr', 'en', 'fallback')).toBe(
      'Assess collaboration skills and engineering judgment in external codebases',
    );
    expect(composeInterviewIntent(undefined, 'zh-CN', 'fallback')).toBe('fallback');
  });

  it('composeCadenceSummary builds the sentence from metrics', () => {
    expect(composeCadenceSummary({ commits: 12, months: 4 }, 'en')).toBe('3.0 commits/month across 4 active months');
    expect(composeCadenceSummary({ commits: 12, months: 4 }, 'zh-CN')).toBe('平均每月 3.0 次提交，共活跃 4 个月');
  });

  it('prSummaryFactsFromProfile reads externalMergedPullRequests from metrics when present', () => {
    const base = {
      activity: { metrics: { totalPullRequests: 5, mergedPullRequests: 3 } },
    } as Parameters<typeof prSummaryFactsFromProfile>[0];
    expect(prSummaryFactsFromProfile(base)).toEqual({ opened: 5, merged: 3 });
    expect(
      prSummaryFactsFromProfile({
        activity: { metrics: { totalPullRequests: 5, mergedPullRequests: 3, externalMergedPullRequests: 2 } },
      } as Parameters<typeof prSummaryFactsFromProfile>[0]),
    ).toEqual({ opened: 5, merged: 3, externalMerged: 2 });
  });

  it('composePrSummary renders the external fragment only when externalMerged > 0', () => {
    expect(composePrSummary({ opened: 2, merged: 1 }, 'zh-CN')).toBe('开过 2 个 PR，合并 1 个');
    expect(composePrSummary({ opened: 2, merged: 1, externalMerged: 1 }, 'zh-CN')).toBe(
      '开过 2 个 PR，合并 1 个，其中 1 个合入他人仓库',
    );
    expect(composePrSummary({ opened: 2, merged: 1, externalMerged: 1 }, 'en')).toBe(
      '2 PR(s) opened, 1 merged, 1 into external projects',
    );
  });
});
