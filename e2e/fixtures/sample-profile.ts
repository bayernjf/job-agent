import { AbilityProfileSchema, type AbilityProfile } from '@jobagent/shared';

/**
 * E2E 专用固定画像（#1）。
 *
 * 严格符合 packages/shared 的 AbilityProfile 契约——storage 落盘时会用
 * parseAbilityProfile 重新校验，任何字段缺失都会让 snapshot 静默变成 null，
 * 因此这里构造后立即 schema.parse 自检，不合规直接在 globalSetup 阶段失败。
 *
 * 数据是确定性的静态样本，不依赖网络/分析引擎，供报告页 SSR 渲染断言。
 */

export const FIXTURE_PROFILE_ID = 'profe2efixture00000000000000';
export const FIXTURE_LOGIN = 'e2e-fixture-user';

/**
 * 融合画像 fixture（#2）：存储行 subject_platform='all'，但 snapshot.subject.platform
 * 刻意仍为 'github'（与线上 platform=all 的落库形态一致，见 design-cross-source-fusion §8）。
 * 用于断言报告页/人才库只能从存储行列识别融合身份并展示双源徽标。
 */
export const FIXTURE_FUSED_PROFILE_ID = 'profe2efixture00000000000001';
export const FIXTURE_FUSED_LOGIN = 'e2e-fused-user';

const EVIDENCE = {
  extPr: 'evt-ext-pr-1',
  ts: 'evt-skill-ts',
  react: 'evt-skill-react',
  longevity: 'evt-longevity',
  cadence: 'evt-cadence',
} as const;

export function buildFixtureProfile(overrides: { id?: string; login?: string; displayName?: string } = {}): AbilityProfile {
  const profileId = overrides.id ?? FIXTURE_PROFILE_ID;
  const login = overrides.login ?? FIXTURE_LOGIN;
  const displayName = overrides.displayName ?? 'E2E Fixture User';
  const profile = {
    profileId,
    analyzerVersion: 'schema-0.1-engine-0.1.0',
    generatedAt: '2026-09-11T08:00:00.000Z',
    dataWindow: {
      since: '2024-09-11T00:00:00.000Z',
      until: '2026-09-11T00:00:00.000Z',
    },
    analysisLayers: ['L0', 'L1'] as const,
    subject: {
      platform: 'github' as const,
      login,
      displayName,
      avatarUrl: `https://avatars.githubusercontent.com/u/0?v=4`,
      profileUrl: `https://github.com/${login}`,
      claimed: false,
    },
    summary: {
      headline: 'E2E fixture: a reliable full-stack developer with steady OSS activity.',
    },
    skillTags: [
      {
        name: 'TypeScript',
        kind: 'language' as const,
        depth: 'proficient' as const,
        confidence: 0.9,
        evidenceRefs: [EVIDENCE.ts],
      },
      {
        name: 'React',
        kind: 'framework' as const,
        depth: 'used' as const,
        confidence: 0.7,
        evidenceRefs: [EVIDENCE.react],
      },
    ],
    activity: {
      longevityMonths: 24,
      cadenceSummary: 'Steady weekly commits across the full data window.',
      metrics: {
        totalCommits: 480,
        mergedPrs: 36,
        openedIssues: 22,
      },
    },
    collaboration: {
      prSummary: 'Opens focused PRs and maintains several shared repositories.',
      externalMergedContributions: ['octo/awesome-lib#12', 'vercel/workflow#88'],
      evidenceRefs: [EVIDENCE.extPr],
    },
    authenticity: {
      status: 'likely_authentic' as const,
      confidence: 0.86,
      signals: [
        {
          code: 'external_contributions',
          severity: 'info' as const,
          label: 'External PRs merged',
          detail: 'Two pull requests were merged into third-party repositories.',
          evidenceRefs: [EVIDENCE.extPr],
        },
      ],
    },
    interviewQuestions: [
      {
        question: 'Walk through your most complex external PR.',
        intent: 'Verify depth of collaboration and code review ability.',
        basisEvidenceRef: EVIDENCE.extPr,
      },
    ],
    caveats: [
      'Private contribution graph and private repositories are not visible; activity may be understated.',
    ],
  };

  // 契约自检：任何字段不符合 AbilityProfile 立即抛错，避免落盘后 snapshot 变 null。
  return AbilityProfileSchema.parse(profile);
}

/** 融合画像 fixture：snapshot 形状与普通画像一致（platform 仍 github），融合身份只在存储行列。 */
export function buildFusedFixtureProfile(): AbilityProfile {
  const base = buildFixtureProfile({
    id: FIXTURE_FUSED_PROFILE_ID,
    login: FIXTURE_FUSED_LOGIN,
    displayName: 'E2E Fused User',
  });
  // 与线上 platform=all 一致：快照带融合报告（镜像合并 + 跨源去重统计），供报告页统计行展示
  return {
    ...base,
    fusion: {
      primaryPlatform: 'github',
      secondaryPlatform: 'gitee',
      mergedMirrors: [
        { primaryRef: 'e2e-fixture-user/core', secondaryRef: 'e2e-fixture-user/core', sharedOidCount: 5 },
      ],
      suspectedMirrors: [],
      dedupedCommitCount: 4,
      dedupedPullRequestCount: 2,
      dedupedIssueCount: 1,
      keptSecondaryRepoRefs: ['e2e-fixture-user/gitee-only'],
      counts: {
        primaryRepos: 2,
        secondaryRepos: 3,
        fusedRepos: 3,
        primaryCommits: 20,
        secondaryCommits: 18,
        fusedCommits: 34,
        primaryPullRequests: 4,
        secondaryPullRequests: 4,
        fusedPullRequests: 6,
        primaryIssues: 3,
        secondaryIssues: 2,
        fusedIssues: 4,
      },
    },
  };
}
