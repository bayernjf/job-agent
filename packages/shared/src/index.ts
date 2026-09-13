import { z } from 'zod';

/**
 * 能力画像契约（v0.1，对应 PRD 第 8 章）。
 *
 * 设计原则：证据源无关、结论必有证据、版本化可复现、不使用单一真实性百分比。
 * 本文件是单一事实源：类型由 schema 派生（z.infer），全链路（采集/分析/API/报告）共用。
 */

export const EvidenceSourceTypeSchema = z.enum([
  'commit',
  'pr',
  'issue',
  'repo',
  'contribution',
  'file',
]);
export type EvidenceSourceType = z.infer<typeof EvidenceSourceTypeSchema>;

/** 统一证据项：任何结论都由 EvidenceItem 支撑；GitHub 只是第一个 source */
export const EvidenceItemSchema = z.object({
  evidenceId: z.string().min(1),
  sourcePlatform: z.string(), // 为多证据源预留：'github' | 'gitee' | 'portfolio' | string
  sourceType: EvidenceSourceTypeSchema,
  url: z.string().url(), // 可点击回溯到原始记录
  occurredAt: z.string().datetime().optional(), // ISO 时间，可空
  layer: z.enum(['L0', 'L1', 'L2', 'L3', 'L4']),
  claim: z.string().min(1), // 该证据支持的结论（人话）
  rawRef: z.string().min(1), // 原始对象指针（如 commit sha / PR number），不存冗余全量
});
export type EvidenceItem = z.infer<typeof EvidenceItemSchema>;

export const AUTHENTICITY_STATUSES = [
  'likely_authentic', // 多数信号指向真实
  'mixed_signals', // 信号冲突，需人工判断
  'suspicious', // 存在较强异常信号
  'insufficient_data', // 证据不足，禁止臆断
] as const;
export const AuthenticityStatusSchema = z.enum(AUTHENTICITY_STATUSES);
export type AuthenticityStatus = z.infer<typeof AuthenticityStatusSchema>;

export const SignalSeveritySchema = z.enum(['info', 'warn', 'risk']);

export const AuthenticitySignalSchema = z.object({
  code: z.string().min(1), // 规则/模型信号码，带版本
  severity: SignalSeveritySchema,
  label: z.string().min(1), // 人话标题
  detail: z.string().min(1), // 具体描述
  evidenceRefs: z.array(z.string().min(1)), // -> EvidenceItem.evidenceId
});
export type AuthenticitySignal = z.infer<typeof AuthenticitySignalSchema>;

export const SkillTagKindSchema = z.enum(['language', 'framework', 'domain']);
export type SkillTagKind = z.infer<typeof SkillTagKindSchema>;
export const SkillTagDepthSchema = z.enum(['used', 'proficient']); // 区分"用过"与"有深度"
export type SkillTagDepth = z.infer<typeof SkillTagDepthSchema>;

export const SkillTagSchema = z.object({
  name: z.string().min(1),
  kind: SkillTagKindSchema,
  depth: SkillTagDepthSchema,
  confidence: z.number().min(0).max(1),
  evidenceRefs: z.array(z.string().min(1)),
});
export type SkillTag = z.infer<typeof SkillTagSchema>;

/** 能力画像快照（不可变，分享链接永远指向生成时版本） */
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
    platform: z.literal('github'),
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
    }),
  ),
  improvementSuggestions: z
    .array(
      z.object({
        suggestion: z.string().min(1),
        why: z.string().min(1),
        evidenceRefs: z.array(z.string().min(1)),
      }),
    )
    .optional(), // C 端 P1
  caveats: z.array(z.string()), // 明确"无法判断"的盲区
});
export type AbilityProfile = z.infer<typeof AbilityProfileSchema>;

/** 契约版本：analyzerVersion 建议按 `契约版本-引擎版本` 组合，保证可复现 */
export const SCHEMA_VERSION = '0.1';

/** 解析能力画像快照（对外统一入口；失败返回 null，由调用方决定降级策略） */
export function parseAbilityProfile(input: unknown): AbilityProfile | null {
  const result = AbilityProfileSchema.safeParse(input);
  return result.success ? result.data : null;
}

/**
 * 可导出画像投影（v0.1，对应决策 #15：Chrome 扩展一键填充的消费契约）。
 *
 * 设计原则：
 * - **只含画像已证实字段**：displayName / login / profileUrl / skills / authenticity；
 *   email、教育、工作经历 GitHub 画像不提供，**不进本契约**，由扩展端引导用户补填并本地保存。
 * - **差异化保留证据**：每条技能携带 evidenceRefs，扩展可展示"每条技能都可回溯到 GitHub 证据"，
 *   而非只填一个技能名字符串。
 * - **可溯源**：profileId / generatedAt / analyzerVersion / schemaVersion 齐全，扩展可向用户展示画像生成时间与版本。
 * - 本投影是纯函数映射（无 I/O），消费方为 P1 Chrome 扩展；远期与投递工具互操作（讨论记录-02 决策 3）可复用。
 */

export const ExportableProfileSchema = z.object({
  schemaVersion: z.string().min(1), // 与 SCHEMA_VERSION 同步（见 toExportableProfile）
  profileId: z.string().min(1),
  generatedAt: z.string().datetime(),
  analyzerVersion: z.string().min(1),
  subject: z.object({
    platform: z.literal('github'),
    login: z.string().min(1),
    displayName: z.string().optional(), // 缺省时扩展可回退显示 login
    avatarUrl: z.string().url().optional(),
    profileUrl: z.string().url(),
    claimed: z.boolean(), // 是否经本人 OAuth 认领（扩展可据此提示"本人已验证"）
  }),
  headline: z.string().min(1), // 一句话定位，可用于自我介绍字段
  skills: z.array(
    z.object({
      name: z.string().min(1),
      kind: SkillTagKindSchema,
      depth: SkillTagDepthSchema,
      confidence: z.number().min(0).max(1),
      evidenceRefs: z.array(z.string().min(1)),
    }),
  ),
  authenticity: z.object({
    status: AuthenticityStatusSchema,
    confidence: z.number().min(0).max(1),
  }),
});
export type ExportableProfile = z.infer<typeof ExportableProfileSchema>;

/** 从完整画像投影出可导出结构（纯函数，无 I/O） */
export function toExportableProfile(profile: AbilityProfile): ExportableProfile {
  return {
    schemaVersion: SCHEMA_VERSION,
    profileId: profile.profileId,
    generatedAt: profile.generatedAt,
    analyzerVersion: profile.analyzerVersion,
    subject: {
      platform: profile.subject.platform,
      login: profile.subject.login,
      ...(profile.subject.displayName !== undefined ? { displayName: profile.subject.displayName } : {}),
      ...(profile.subject.avatarUrl !== undefined ? { avatarUrl: profile.subject.avatarUrl } : {}),
      profileUrl: profile.subject.profileUrl,
      claimed: profile.subject.claimed,
    },
    headline: profile.summary.headline,
    skills: profile.skillTags.map((skill) => ({
      name: skill.name,
      kind: skill.kind,
      depth: skill.depth,
      confidence: skill.confidence,
      evidenceRefs: skill.evidenceRefs,
    })),
    authenticity: {
      status: profile.authenticity.status,
      confidence: profile.authenticity.confidence,
    },
  };
}

/** 解析可导出画像（对外统一入口；失败返回 null，由调用方决定降级策略） */
export function parseExportableProfile(input: unknown): ExportableProfile | null {
  const result = ExportableProfileSchema.safeParse(input);
  return result.success ? result.data : null;
}

/**
 * 职位发布契约（P2 职位聚合预留，2026-09-13 Spike 实证落地）。
 *
 * 设计原则：source+sourceUrl 是去重唯一键；只存精简字段（描述剥离 HTML），
 * 不存源站 raw 全量（对齐 AGENTS 快照原则）；数据源实测结论见
 * docs/设计-职位聚合-Spike-20260913.md。
 */
export const JobSourceSchema = z.enum([
  'remoteok',
  'remotive',
  'greenhouse',
  'lever',
  'hn_whoishiring',
  'weworkremotely',
]);
export type JobSource = z.infer<typeof JobSourceSchema>;

export const JobPostingSchema = z.object({
  jobId: z.string().min(1),
  source: JobSourceSchema,
  sourceUrl: z.string().url(), // 原平台绝对 URL（同源去重唯一键）
  title: z.string().min(1),
  company: z.string().min(1),
  location: z.string().nullish(), // 源站原文（如 "Remote - US" / "Foster City, California"）
  remote: z.boolean(), // 是否远程（源字段或 location 解析）
  salaryMin: z.number().nullish(), // 统一年化美元；未知为 null
  salaryMax: z.number().nullish(),
  salaryCurrency: z.string().nullish(),
  tags: z.array(z.string()).default([]),
  description: z.string().nullish(), // 精简文本（HTML 剥离后）
  postedAt: z.string().datetime(), // 源发布时间（ISO）
  fetchedAt: z.string().datetime(), // 我方抓取时间（ISO）
  applyUrl: z.string().url().optional(), // 独立申请入口（Greenhouse/Lever 有）
  companyLogoUrl: z.string().url().optional(),
  companyUrl: z.string().url().optional(), // 公司主页（YC batch 等补充字段）
});
export type JobPosting = z.infer<typeof JobPostingSchema>;
