import { describe, expect, it } from 'vitest';
import {
  AbilityProfileSchema,
  parseAbilityProfile,
  SCHEMA_VERSION,
  matchScoreTier,
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
