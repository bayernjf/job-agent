/**
 * 能力画像契约（从 index.ts 拆出，审查动作 #8；PRD 第 8 章）。
 * 结论必有证据、版本化可复现、不使用单一真实性百分比。
 */
import { z } from 'zod';
import {
  AuthenticitySignalSchema,
  AuthenticityStatusSchema,
  InterviewQuestionKindSchema,
  SignalFactsSchema,
  SkillTagSchema,
} from './evidence.js';
import { L3SignalsSchema } from './semantic.js';

/** 能力画像快照（不可变，分享链接永远指向生成时版本） */
/** 支持的证据源平台：github 为首个 EvidenceSource，gitee 为第二个（2026-09-14） */
export const PlatformSchema = z.enum(['github', 'gitee']);
export type SupportedPlatform = z.infer<typeof PlatformSchema>;
export const SUPPORTED_PLATFORMS = PlatformSchema.options;

/** 跨源镜像配对（共享 commit oid 确定），用于双源融合报告 */
export const MirrorPairSchema = z.object({
  primaryRef: z.string().min(1),
  secondaryRef: z.string().min(1),
  sharedOidCount: z.number().int().nonnegative(),
});
export type MirrorPair = z.infer<typeof MirrorPairSchema>;

/** 疑似镜像（仅同名，只报告不合并） */
export const SuspectedMirrorSchema = z.object({
  primaryRef: z.string().min(1),
  secondaryRef: z.string().min(1),
  reason: z.enum(['same_name']),
});
export type SuspectedMirror = z.infer<typeof SuspectedMirrorSchema>;

/** 双源融合各对象在主源 / 辅源 / 融合后的数量 */
export const FusionCountsSchema = z.object({
  primaryRepos: z.number().int().nonnegative(),
  secondaryRepos: z.number().int().nonnegative(),
  fusedRepos: z.number().int().nonnegative(),
  primaryCommits: z.number().int().nonnegative(),
  secondaryCommits: z.number().int().nonnegative(),
  fusedCommits: z.number().int().nonnegative(),
  primaryPullRequests: z.number().int().nonnegative(),
  secondaryPullRequests: z.number().int().nonnegative(),
  fusedPullRequests: z.number().int().nonnegative(),
  primaryIssues: z.number().int().nonnegative(),
  secondaryIssues: z.number().int().nonnegative(),
  fusedIssues: z.number().int().nonnegative(),
});
export type FusionCounts = z.infer<typeof FusionCountsSchema>;

/**
 * 跨源融合报告（仅 platform=all 双源成功融合时存在；单源画像缺省）。
 * 记录镜像合并与跨源去重统计，随画像快照持久化，供报告页说明"融合/去重了什么"；
 * 不参与真实性 / 技能等结论计算（融合只是输入预处理）。可选字段，旧快照无此节仍可解析。
 */
export const FusionReportSchema = z.object({
  primaryPlatform: PlatformSchema,
  secondaryPlatform: PlatformSchema,
  mergedMirrors: z.array(MirrorPairSchema),
  suspectedMirrors: z.array(SuspectedMirrorSchema),
  /** 因镜像而丢弃的重复 commit 数 */
  dedupedCommitCount: z.number().int().nonnegative(),
  /** 镜像仓内跨源同帖而丢弃的重复 PR 数（保留主源版本） */
  dedupedPullRequestCount: z.number().int().nonnegative(),
  /** 镜像仓内跨源同帖而丢弃的重复 issue 数（保留主源版本） */
  dedupedIssueCount: z.number().int().nonnegative(),
  /** 保留下来的辅源仓库（独有 + 疑似未并） */
  keptSecondaryRepoRefs: z.array(z.string()),
  counts: FusionCountsSchema,
});
export type FusionReport = z.infer<typeof FusionReportSchema>;

/**
 * 改进建议（T09 生产者 / T10 渲染）。
 *
 * 每条建议带一个**稳定 code**，文案由 `composeImprovementSuggestion` 按读者语言现拼——
 * 与 headline（`composeHeadline`）同一套路：内核只存一份数据层英文原文，双语表面各自现拼，
 * 否则中文报告页会直接贴英文（T23 登记的那类问题）。渲染侧只认 code，不按英文句子匹配。
 */
export const IMPROVEMENT_SUGGESTION_CODES = ['no_pull_requests', 'no_external_contributions'] as const;
export const ImprovementSuggestionCodeSchema = z.enum(IMPROVEMENT_SUGGESTION_CODES);
export type ImprovementSuggestionCode = z.infer<typeof ImprovementSuggestionCodeSchema>;

export const ImprovementSuggestionSchema = z.object({
  code: ImprovementSuggestionCodeSchema,
  suggestion: z.string().min(1), // 数据层英文原句（API/CLI/存档消费）
  why: z.string().min(1),
  evidenceRefs: z.array(z.string().min(1)), // 必挂真实证据；无证据不产建议
});
export type ImprovementSuggestion = z.infer<typeof ImprovementSuggestionSchema>;

export const AbilityProfileSchema = z.object({
  profileId: z.string().min(1),
  analyzerVersion: z.string().min(1), // 分析引擎版本，保证可复现
  generatedAt: z.string().datetime(),
  dataWindow: z.object({
    since: z.string().datetime(),
    until: z.string().datetime(),
  }),
  analysisLayers: z.array(z.enum(['L0', 'L1'])), // MVP 仅 L0/L1
  subject: z.object({
    platform: PlatformSchema,
    login: z.string().min(1),
    displayName: z.string().optional(),
    avatarUrl: z.string().url().optional(),
    profileUrl: z.string().url(),
    claimed: z.boolean(), // 是否经本人 OAuth 认领
  }),
  summary: z.object({
    headline: z.string().min(1),
    seniorityHint: z
      .object({
        band: z.string().min(1),
        confidence: z.number().min(0).max(1),
        evidenceRefs: z.array(z.string().min(1)),
      })
      .optional(),
  }),
  skillTags: z.array(SkillTagSchema),
  activity: z.object({
    longevityMonths: z.number().int().nonnegative().optional(),
    cadenceSummary: z.string().optional(),
    burstPattern: AuthenticitySignalSchema.optional(), // 时序异常作为信号而非分数
    metrics: z.record(z.string(), z.number()).optional(), // 仅放可由 API 直接得到的计数
  }),
  collaboration: z.object({
    prSummary: z.string().optional(),
    externalMergedContributions: z.array(z.string()).optional(), // 被他人项目 merge 的强信号
    evidenceRefs: z.array(z.string().min(1)),
  }),
  authenticity: z.object({
    status: AuthenticityStatusSchema,
    confidence: z.number().min(0).max(1), // 置信度，非"真实度百分比"
    signals: z.array(AuthenticitySignalSchema),
  }),
  interviewQuestions: z.array(
    z.object({
      question: z.string().min(1),
      intent: z.string().min(1),
      basisEvidenceRef: z.string().min(1),
      // T33：kind 决定渲染分支（composeInterviewIntent 按 kind 现拼意图文案）；
      // facts 存题目涉及的仓库/PR/Issue 结构化事实（如 repo 名、star 数、issue 数）。
      kind: InterviewQuestionKindSchema.optional(),
      facts: SignalFactsSchema.optional(),
    }),
  ),
  improvementSuggestions: z.array(ImprovementSuggestionSchema).optional(), // C 端 P1（T09 产、T10 渲染）
  caveats: z.array(z.string()), // 明确"无法判断"的盲区
  fusion: FusionReportSchema.optional(), // 仅双源融合画像存在（platform=all），单源画像缺省
  semantic: z.lazy(() => L3SignalsSchema).optional(), // L3 语义层信号（L3-A 规则版 / L3-B LLM 摘要），调用方透传并入快照
});
export type AbilityProfile = z.infer<typeof AbilityProfileSchema>;

/** 契约版本：analyzerVersion 建议按 `契约版本-引擎版本` 组合，保证可复现 */
export const SCHEMA_VERSION = '0.1';

/** 解析能力画像快照（对外统一入口；失败返回 null，由调用方决定降级策略） */
export function parseAbilityProfile(input: unknown): AbilityProfile | null {
  const result = AbilityProfileSchema.safeParse(input);
  return result.success ? result.data : null;
}
