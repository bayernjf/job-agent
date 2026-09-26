import {
  AbilityProfileSchema,
  composeHeadline,
  composeImprovementSuggestion,
  type AbilityProfile,
} from '@jobagent/shared';

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

/**
 * Gitee 主体画像 fixture（#3）：snapshot.subject.platform='gitee'，存储行 subject_platform='gitee'。
 * 用于断言授权分级闸的 SSR 登录墙按画像主体平台引导到 Gitee OAuth（而非 GitHub）。
 */
export const FIXTURE_GITEE_PROFILE_ID = 'profe2efixture00000000000002';
export const FIXTURE_GITEE_LOGIN = 'e2e-gitee-user';

/**
 * 已认领画像 fixture（#4，决策 #17-F11 投递管道隐私）：存储行 subject_claimed=true，
 * 主体平台/登录名与 FIXTURE_SESSION_TOKEN 所属账号一致（github / FIXTURE_LOGIN）。
 * 刻意用**独立 id**，不动 FIXTURE_PROFILE_ID——那里"未认领 → 显示认领 CTA 与
 * 未经本人授权提示条"的断言仍依赖它是无主的。
 */
export const FIXTURE_CLAIMED_PROFILE_ID = 'profe2efixture00000000000003';

/**
 * "下一步动作"画像 fixture（#5，T10 渲染 E2E）：只有自有仓库里的提交、从未开 PR，
 * 因此 `improvementSuggestions` 里的 `no_pull_requests` 与画像事实自洽
 * （标准 fixture 有外部合并 PR，挂任何一条建议都会自相矛盾）。
 */
export const FIXTURE_NEXT_STEPS_PROFILE_ID = 'profe2efixture00000000000004';
export const FIXTURE_NEXT_STEPS_LOGIN = 'e2e-next-steps-user';
export const FIXTURE_NEXT_STEPS_EVIDENCE_ID = 'evt-next-steps-commit';

/**
 * globalSetup 实际落盘的全部画像 id（人才库 E2E 据此断言卡片数，
 * 新增 fixture 时只改这里，不用再回去数 spec 里的硬编码）。
 */
export const FIXTURE_PROFILE_IDS = [
  FIXTURE_PROFILE_ID,
  FIXTURE_FUSED_PROFILE_ID,
  FIXTURE_GITEE_PROFILE_ID,
  FIXTURE_CLAIMED_PROFILE_ID,
  FIXTURE_NEXT_STEPS_PROFILE_ID,
] as const;

/**
 * 授权分级闸 E2E：一个本人账号（login 与 FIXTURE_LOGIN 一致）+ 固定未过期会话 token。
 * spec 用 context.addCookies 种 jobagent_session 模拟"已登录 user"。
 */
export const FIXTURE_ACCOUNT_PROVIDER_ID = '9001';
export const FIXTURE_SESSION_TOKEN = 'ses-e2e-fixed-active-token';


const EVIDENCE = {
  extPr: 'evt-ext-pr-1',
  ts: 'evt-skill-ts',
  react: 'evt-skill-react',
  longevity: 'evt-longevity',
  cadence: 'evt-cadence',
} as const;

export function buildFixtureProfile(
  overrides: { id?: string; login?: string; displayName?: string; platform?: 'github' | 'gitee' } = {},
): AbilityProfile {
  const profileId = overrides.id ?? FIXTURE_PROFILE_ID;
  const login = overrides.login ?? FIXTURE_LOGIN;
  const displayName = overrides.displayName ?? 'E2E Fixture User';
  const platform = overrides.platform ?? 'github';
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
      platform,
      login,
      displayName,
      avatarUrl:
        platform === 'gitee'
          ? 'https://gitee.com/assets/no_portrait.png'
          : `https://avatars.githubusercontent.com/u/0?v=4`,
      profileUrl: platform === 'gitee' ? `https://gitee.com/${login}` : `https://github.com/${login}`,
      claimed: false,
    },
    summary: {
      // 与分析内核落盘时同一句（数据层英文）；报告页按读者语言另行现拼（T07）
      headline: composeHeadline({ platform, language: 'TypeScript', months: 24 }, 'en'),
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

/** Gitee 主体画像 fixture：subject.platform='gitee'，其余与标准 fixture 同形。 */
export function buildGiteeFixtureProfile(): AbilityProfile {
  return buildFixtureProfile({
    id: FIXTURE_GITEE_PROFILE_ID,
    login: FIXTURE_GITEE_LOGIN,
    displayName: 'E2E Gitee User',
    platform: 'gitee',
  });
}

/** 已认领画像 fixture：与标准 fixture 同形，只把快照的 claimed 置真（存储行由 global-setup 置真）。 */
export function buildClaimedFixtureProfile(): AbilityProfile {
  const base = buildFixtureProfile({ id: FIXTURE_CLAIMED_PROFILE_ID });
  return AbilityProfileSchema.parse({ ...base, subject: { ...base.subject, claimed: true } });
}

/**
 * "下一步动作"画像 fixture（T10）：提交都在自有仓库、一个 PR 都没开，
 * 所以唯一成立的建议是 `no_pull_requests`；协作/信号字段同步收敛，避免画像内部自相矛盾。
 */
export function buildNextStepsFixtureProfile(): AbilityProfile {
  const base = buildFixtureProfile({
    id: FIXTURE_NEXT_STEPS_PROFILE_ID,
    login: FIXTURE_NEXT_STEPS_LOGIN,
    displayName: 'E2E Next Steps User',
  });
  return AbilityProfileSchema.parse({
    ...base,
    activity: {
      longevityMonths: 8,
      cadenceSummary: 'Weekly commits, all inside the subject\'s own repositories.',
      metrics: { totalCommits: 42, totalRepos: 3 },
    },
    collaboration: { evidenceRefs: [FIXTURE_NEXT_STEPS_EVIDENCE_ID] },
    authenticity: {
      status: 'likely_authentic',
      confidence: 0.72,
      signals: [],
    },
    interviewQuestions: [],
    improvementSuggestions: [
      {
        code: 'no_pull_requests',
        // 数据层英文原文由内核写入；报告页按读者语言现拼（与 T07 headline 同套路）
        ...composeImprovementSuggestion('no_pull_requests', 'en'),
        evidenceRefs: [FIXTURE_NEXT_STEPS_EVIDENCE_ID],
      },
    ],
  });
}

/** 融合画像 fixture：snapshot 形状与普通画像一致（platform 仍 github），融合身份只在存储行列。 */export function buildFusedFixtureProfile(): AbilityProfile {
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
