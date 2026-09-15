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
/** 支持的证据源平台：github 为首个 EvidenceSource，gitee 为第二个（2026-09-14） */
export const PlatformSchema = z.enum(['github', 'gitee']);
export type SupportedPlatform = z.infer<typeof PlatformSchema>;
export const SUPPORTED_PLATFORMS = PlatformSchema.options;

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
    platform: PlatformSchema,
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

/**
 * 匹配分三档（报告页与扩展共用，单一事实源，2026-09-14）。
 *
 * 匹配分随命中技能数叠加（每个技能满分 6 = title×3 + tags×2 + description×1），
 * 故按相对比例分档而非绝对阈值，避免多技能画像被固定阈值误判为 high。
 * - high：score ≥ 80% 满分
 * - mid：score ≥ 40% 满分
 * - low：score < 40%，或无命中技能
 */
export type MatchScoreTier = 'high' | 'mid' | 'low';

export function matchScoreTier(score: number, matchedSkillCount: number): MatchScoreTier {
  if (matchedSkillCount <= 0) return 'low';
  const ratio = score / (matchedSkillCount * 6);
  if (ratio >= 0.8) return 'high';
  if (ratio >= 0.4) return 'mid';
  return 'low';
}

/**
 * 演示模式契约（2026-09-15，对应 docs/design-demo-mode-20260915.md）。
 *
 * 三态请求身份：anonymous 匿名访客 / demo 免注册临时演示会话 / user 正式用户。
 * 'user' 仅为未来账号体系（OAuth/认领，当前缓做）预留，本期没有任何代码路径产生它。
 */
export const REQUESTER_KINDS = ['anonymous', 'demo', 'user'] as const;
export const RequesterKindSchema = z.enum(REQUESTER_KINDS);
export type RequesterKind = z.infer<typeof RequesterKindSchema>;

/** IP 滑动窗口限流的桶类型：建会话 / 触发分析 */
export const DEMO_RATE_KINDS = ['session', 'analyze'] as const;
export const DemoRateKindSchema = z.enum(DEMO_RATE_KINDS);
export type DemoRateKind = z.infer<typeof DemoRateKindSchema>;

/**
 * 三态 Principal（API 边缘中间件解析一次，下游 handler 只读，不各自解析 Cookie）。
 * 坏/过期 Cookie 静默降级为 anonymous；sessionId 即 Cookie 值、也是 demo_sessions 主键。
 */
export type Principal =
  | { kind: 'anonymous' }
  | {
      kind: 'demo';
      sessionId: string;
      analyzeCount: number; // 本会话已用新分析次数
      matchCount: number; // match 观测计数（默认无硬配额）
      expiresAt: string; // ISO8601
    }
  | { kind: 'user'; userId: string }; // reserved for accounts milestone, never produced today

/** GET /demo/me 响应体：anonymous 只回 kind；demo 另带配额状态 */
export const DemoMeSchema = z.object({
  kind: RequesterKindSchema,
  sessionId: z.string().optional(), // 仅 kind='demo'
  expiresAt: z.string().optional(),
  analyzeQuota: z.number().int().nonnegative().optional(),
  analyzeUsed: z.number().int().nonnegative().optional(),
  analyzeRemaining: z.number().int().nonnegative().optional(),
});
export type DemoMe = z.infer<typeof DemoMeSchema>;

/** GET /demo/presets 单项：预置示例账号及其画像快照是否就绪（未 seed 时 ready=false，前端隐藏） */
export const DemoPresetSchema = z.object({
  platform: PlatformSchema,
  login: z.string().min(1),
  authenticity: z.string(), // AuthenticityStatus；缺失时允许 'unknown'
  profileId: z.string().nullable(),
  ready: z.boolean(),
});
export type DemoPreset = z.infer<typeof DemoPresetSchema>;

/** 演示模式结构化错误码（前后端共用单一事实源，避免前端硬编码字符串） */
export const DEMO_ERROR_CODES = {
  demoRequired: 'DEMO_REQUIRED', // 403：匿名且缓存未命中触发新分析，前端据此自动建会话重试
  quotaExceeded: 'DEMO_QUOTA_EXCEEDED', // 429：会话分析次数用尽
  rateLimited: 'DEMO_RATE_LIMITED', // 429：IP 滑动窗口超限
} as const;
export type DemoErrorCode = (typeof DEMO_ERROR_CODES)[keyof typeof DEMO_ERROR_CODES];

// ─── 岗位定向简历（2026-09-15，对应 docs/design-targeted-resume-20260915.md）────────
//
// 设计原则（三铁律）：
//  1. no-fabrication：简历每条 profile 来源条目必须挂 evidenceRefs，可回溯 EvidenceItem；
//     画像不提供的字段（教育/工作经历/联系方式）只走 LocalResumeFields 本地补填、标 source:'local'；
//  2. 定向 = 选择 + 排序 + 模板组装，不改写画像事实；
//  3. provenance：规则/分析版本随草稿输出，保证可复现。

/** 简历装配规则版本：排序/模板逻辑变更时递增，写入 ResumeDraft.provenance */
export const RESUME_RULE_VERSION = '0.1';

/** 简历支持的语言（P-R1 用户手选，默认 zh-CN；技能名等事实保持画像原文不翻译） */
export const ResumeLocaleSchema = z.enum(['zh-CN', 'en']);
export type ResumeLocale = z.infer<typeof ResumeLocaleSchema>;

/**
 * 用户本地补填字段（画像不提供，绝不臆造）。
 * 仅在请求/本机存在：CLI 读 --local-fields JSON，P-R2 网页端存 localStorage，服务端不持久化。
 */
export const LocalResumeEducationSchema = z.object({
  school: z.string().min(1),
  degree: z.string().min(1),
  period: z.string().optional(), // 自由文本，如 "2018–2022"，不做日期强校验
});
export const LocalResumeWorkSchema = z.object({
  company: z.string().min(1),
  role: z.string().min(1),
  period: z.string().optional(),
  detail: z.string().optional(),
});
export const LocalResumeFieldsSchema = z.object({
  fullName: z.string().optional(),
  email: z.string().optional(),
  phone: z.string().optional(),
  location: z.string().optional(),
  personalSite: z.string().url().optional(),
  education: z.array(LocalResumeEducationSchema).optional(),
  workHistory: z.array(LocalResumeWorkSchema).optional(),
});
export type LocalResumeFields = z.infer<typeof LocalResumeFieldsSchema>;

/** 简历条目来源：profile=画像证据（refs 必须非空）；local=用户本地补填（refs 为空） */
export const ResumeEntrySourceSchema = z.enum(['profile', 'local']);
export type ResumeEntrySource = z.infer<typeof ResumeEntrySourceSchema>;

/**
 * 一条可回溯的简历条目（技能 / 证据亮点 / 协作 / 补填经历统一形状）。
 * source:'profile' 时 evidenceRefs 必须非空（no-fabrication 的结构化抓手）。
 */
export const ResumeEntrySchema = z
  .object({
    text: z.string().min(1), // 展示文本：技能名 / 证据 claim / 补填文本，不新造事实
    evidenceRefs: z.array(z.string().min(1)), // -> EvidenceItem.evidenceId；local 条目为空数组
    source: ResumeEntrySourceSchema,
    url: z.string().url().optional(), // 证据原始 URL（commit/PR/Issue）
    occurredAt: z.string().optional(),
    supportsSkills: z.array(z.string()).default([]), // 该条目支撑哪些「岗位命中技能」
    kind: z.string().optional(), // 技能条目记 SkillTag.kind（language/framework/domain），其余省略
    depth: SkillTagDepthSchema.optional(), // 技能条目记深度
  })
  .superRefine((entry, ctx) => {
    if (entry.source === 'profile' && entry.evidenceRefs.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'profile-sourced resume entry must carry at least one evidenceRef',
        path: ['evidenceRefs'],
      });
    }
  });
export type ResumeEntry = z.infer<typeof ResumeEntrySchema>;

/** 针对岗位的改进提示（只提示、不写进简历正文） */
export const ResumeSuggestionSchema = z.object({
  kind: z.enum(['missing_skill', 'missing_field', 'low_match']),
  text: z.string().min(1),
});
export type ResumeSuggestion = z.infer<typeof ResumeSuggestionSchema>;

/** 岗位定向简历草稿（resume-core 纯函数产出，渲染层据此出 Markdown/HTML） */
export const ResumeDraftSchema = z.object({
  schemaVersion: z.string().min(1),
  ruleVersion: z.string().min(1),
  generatedAt: z.string().datetime(),
  subject: z.object({
    login: z.string().min(1),
    displayName: z.string().optional(),
    profileUrl: z.string().url(),
  }),
  targetJob: z.object({
    jobId: z.string().min(1),
    title: z.string().min(1),
    company: z.string().min(1),
    sourceUrl: z.string().url(),
    matchScore: z.number(),
    tier: z.enum(['high', 'mid', 'low']), // 与 shared MatchScoreTier 同值
    matchedSkills: z.array(z.string()),
    fieldScores: z.object({ title: z.number(), tags: z.number(), description: z.number() }),
  }),
  header: z.object({
    name: z.string().min(1),
    headline: z.string().min(1),
    contact: z.record(z.string(), z.string()).optional(),
  }),
  summary: z.string().min(1), // 模板组装，槽位全部来自画像/匹配，不新增事实
  matchedSkills: z.array(ResumeEntrySchema), // 岗位命中、置顶（ATS 关键词覆盖）
  otherSkills: z.array(ResumeEntrySchema), // 画像有、岗位未提（保留不删，排序在后）
  evidenceHighlights: z.array(ResumeEntrySchema), // 支撑命中技能的证据，按强度排序
  collaboration: z.array(ResumeEntrySchema).default([]), // 外部 merged PR 等强信号
  localSections: z.object({
    education: z.array(ResumeEntrySchema).default([]),
    workHistory: z.array(ResumeEntrySchema).default([]),
  }),
  suggestions: z.array(ResumeSuggestionSchema),
  gaps: z.array(z.string()), // 画像缺失、需用户补填的字段
  provenance: z.object({
    profileId: z.string().min(1),
    analyzerVersion: z.string().min(1),
    ruleVersion: z.string().min(1),
  }),
});
export type ResumeDraft = z.infer<typeof ResumeDraftSchema>;

/** 解析简历草稿（对外统一入口；失败返回 null，由调用方决定降级） */
export function parseResumeDraft(input: unknown): ResumeDraft | null {
  const result = ResumeDraftSchema.safeParse(input);
  return result.success ? result.data : null;
}
