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
  fusion: FusionReportSchema.optional(), // 仅双源融合画像存在（platform=all），单源画像缺省
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
 * 'user' 自账号里程碑（2026-09-18，决策 #1-A/#6-A）起由平台 OAuth 登录会话产生。
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
 * 坏/过期 Cookie 静默降级为 anonymous；demo 的 sessionId 即 Cookie 值、也是 demo_sessions 主键；
 * user 的 sessionId 是 auth_sessions 主键（不透明会话 Cookie jobagent_session 的值）。
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
  | {
      kind: 'user'; // 正式登录用户（2026-09-18 起由 OAuth 会话产生）
      accountId: string; // accounts.id
      sessionId: string; // auth_sessions.id（不透明会话 token）
      platform: SupportedPlatform; // 登录平台（首期 github）
      login: string; // 平台登录名
      expiresAt: string; // ISO8601
    };

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

// ─── 账号体系 / 本人 OAuth 认领（2026-09-18，决策 #1-A / #6-A）────────────
//
// 正式用户经平台 OAuth（首期 GitHub web application flow）登录，服务端存不透明会话
// （auth_sessions，HttpOnly Cookie jobagent_session）。登录后可把"主体 platform/login
// 与本人一致"的画像快照标记为已认领（profiles.subject_claimed=true）。未授权访问他人
// 画像仅给公开轻预览的"授权分级闸"为后续一刀，本期先落地登录 + 本人认领。
// 最小化 PII：对外身份响应不回 email / 平台数字 id，仅回登录名、展示名、头像与认领画像。

/** 认证会话 Cookie 名（HttpOnly、不透明 token = auth_sessions 主键） */
export const AUTH_SESSION_COOKIE = 'jobagent_session';
/** OAuth state 临时 Cookie 名（防 CSRF，回调校验后立即清除） */
export const AUTH_STATE_COOKIE = 'jobagent_oauth_state';
/** OAuth 登录后回跳深链临时 Cookie 名（同源相对路径，回调消费后立即清除，10 分钟有效） */
export const AUTH_RETURN_COOKIE = 'jobagent_oauth_return';

/** GET /auth/me 响应体：anonymous 只回 kind；user 回账号非敏感字段 */
export const AuthMeSchema = z.object({
  kind: RequesterKindSchema,
  accountId: z.string().optional(), // 仅 kind='user'
  platform: PlatformSchema.optional(),
  login: z.string().optional(),
  name: z.string().nullable().optional(),
  avatarUrl: z.string().nullable().optional(),
  claimedProfileId: z.string().nullable().optional(),
  expiresAt: z.string().optional(),
});
export type AuthMe = z.infer<typeof AuthMeSchema>;

/** POST /profiles/:id/claim 响应体：认领成功后回画像主体与认领标记 */
export const ClaimResultSchema = z.object({
  profileId: z.string().min(1),
  claimed: z.literal(true),
  subject: z.object({
    platform: PlatformSchema,
    login: z.string().min(1),
  }),
  claimedProfileId: z.string().nullable(),
});
export type ClaimResult = z.infer<typeof ClaimResultSchema>;

/** 账号体系结构化错误码（前后端共用单一事实源） */
export const AUTH_ERROR_CODES = {
  authRequired: 'AUTH_REQUIRED', // 401：未登录却调用需登录端点
  notConfigured: 'AUTH_NOT_CONFIGURED', // 501：服务端未配置该平台 OAuth 凭证
  invalidState: 'AUTH_INVALID_STATE', // 400：OAuth state 缺失/不匹配（可能 CSRF）
  exchangeFailed: 'AUTH_EXCHANGE_FAILED', // 502：用授权码换 token / 取用户资料失败
  profileNotFound: 'AUTH_PROFILE_NOT_FOUND', // 404：认领的画像不存在
  notProfileOwner: 'AUTH_NOT_PROFILE_OWNER', // 403：画像主体 platform/login 与登录账号不一致
} as const;
export type AuthErrorCode = (typeof AUTH_ERROR_CODES)[keyof typeof AUTH_ERROR_CODES];

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

// ─── 统一本地档案 canonical（2026-09-16，item19 ①，对应 design-targeted-resume §5.4.1）────
//
// 报告页简历补填与扩展 ATS 补填原先各持一份形状/键名不同的本地字段，现统一到本 canonical
// 契约：两端都编辑、存储同一份 LocalProfileFields（各自本机 localStorage，物理隔离、仍不
// 跨域自动同步），再用下面的纯函数投影到简历请求形状（LocalResumeFields）与 ATS 填充形状
// （LocalAtsFields）。本段零 I/O、不碰 DOM，localStorage 读写薄壳留在各前端。

/** 统一本地档案存储键（报告页产品域与扩展 ATS 域各存一份，互不可见） */
export const LOCAL_PROFILE_STORAGE_KEY = 'jobagent.localProfile';
/** 报告页旧键，首次读取迁移到 canonical 后删除 */
export const LEGACY_RESUME_FIELDS_STORAGE_KEY = 'jobagent.localResumeFields';
/** 扩展 ATS 旧键，首次读取迁移到 canonical 后删除 */
export const LEGACY_ATS_FIELDS_STORAGE_KEY = 'jobagent.localFields';

export const LocalProfileEducationSchema = z.object({
  school: z.string().min(1),
  degree: z.string().optional(),
  start: z.string().optional(), // 宽松字符串（"2018-09" / "2018" / "至今"），不强校验日期
  end: z.string().optional(),
});
export type LocalProfileEducation = z.infer<typeof LocalProfileEducationSchema>;

export const LocalProfileWorkSchema = z.object({
  company: z.string().min(1),
  role: z.string().optional(),
  start: z.string().optional(),
  end: z.string().optional(),
  detail: z.string().optional(),
});
export type LocalProfileWork = z.infer<typeof LocalProfileWorkSchema>;

export const LocalProfileFieldsSchema = z.object({
  fullName: z.string().optional(),
  email: z.string().optional(),
  phone: z.string().optional(),
  location: z.string().optional(),
  personalSite: z.string().url().optional(),
  linkedinUrl: z.string().url().optional(),
  education: z.array(LocalProfileEducationSchema).optional(),
  workHistory: z.array(LocalProfileWorkSchema).optional(),
});
export type LocalProfileFields = z.infer<typeof LocalProfileFieldsSchema>;

/** ATS 一键填充所需的本地字段形状（扩展 toFillValues 消费；canonical 的 ATS 投影目标） */
export const LocalAtsEducationSchema = z.object({
  school: z.string().min(1),
  degree: z.string().optional(),
  start: z.string().optional(),
  end: z.string().optional(),
});
export const LocalAtsExperienceSchema = z.object({
  company: z.string().min(1),
  title: z.string().optional(),
  start: z.string().optional(),
  end: z.string().optional(),
});
export const LocalAtsFieldsSchema = z.object({
  email: z.string().optional(),
  phone: z.string().optional(),
  location: z.string().optional(),
  linkedinUrl: z.string().url().optional(),
  education: z.array(LocalAtsEducationSchema).optional(),
  experience: z.array(LocalAtsExperienceSchema).optional(),
});
export type LocalAtsFields = z.infer<typeof LocalAtsFieldsSchema>;

const cleanScalar = (v?: string): string | undefined => {
  const t = v?.trim();
  return t ? t : undefined;
};

/** 结构化起止 → 简历用自由文本时间段；只有一个就返回那个，都空返回 undefined */
export function formatRange(start?: string, end?: string): string | undefined {
  const s = cleanScalar(start);
  const e = cleanScalar(end);
  if (s && e) return `${s} – ${e}`;
  return s ?? e;
}

/**
 * 把旧简历的自由文本 period 拆回结构化 start/end（一次性迁移用，尽力而为、不丢字符）。
 * - en/em dash、波浪号、"到"、"至"（排除"至今"）视为范围分隔符；
 * - 连字符 `-` 仅在两侧都含 4 位年份时才切（避免把单日期 "2018-09" 切开）；
 * - 切不出范围则整段入 start。
 */
export function splitRange(text?: string): { start?: string; end?: string } {
  const raw = cleanScalar(text);
  if (!raw) return {};
  const dash = raw.match(/^(.*?)\s*(?:[–—~～到]|至(?!今))\s*(.+)$/);
  if (dash) {
    const start = cleanScalar(dash[1]);
    const end = cleanScalar(dash[2]);
    if (start && end) return { start, end };
  }
  const hyphen = raw.match(/^(.+?)\s*-\s*(.+)$/);
  if (hyphen) {
    const a = hyphen[1]?.trim();
    const b = hyphen[2]?.trim();
    if (a && b && /\d{4}/.test(a) && /\d{4}/.test(b)) return { start: a, end: b };
  }
  return { start: raw };
}

/** 规整 canonical：trim 标量、丢弃空 school/company 行、去掉空数组（存储/发送前统一调用） */
export function sanitizeLocalProfile(input: LocalProfileFields): LocalProfileFields {
  const out: LocalProfileFields = {};
  (['fullName', 'email', 'phone', 'location', 'personalSite', 'linkedinUrl'] as const).forEach((k) => {
    const v = cleanScalar(input[k]);
    if (v) out[k] = v;
  });
  const education = (input.education ?? [])
    .filter((e) => Boolean(cleanScalar(e.school)))
    .map((e) => ({
      school: cleanScalar(e.school) as string,
      degree: cleanScalar(e.degree),
      start: cleanScalar(e.start),
      end: cleanScalar(e.end),
    }));
  if (education.length) out.education = education;
  const workHistory = (input.workHistory ?? [])
    .filter((w) => Boolean(cleanScalar(w.company)))
    .map((w) => ({
      company: cleanScalar(w.company) as string,
      role: cleanScalar(w.role),
      start: cleanScalar(w.start),
      end: cleanScalar(w.end),
      detail: cleanScalar(w.detail),
    }));
  if (workHistory.length) out.workHistory = workHistory;
  return out;
}

/**
 * canonical → 简历请求形状（严格投影，绝不臆造）。
 * - personalSite 缺省时用 linkedinUrl 落到简历唯一 URL 槽；
 * - period 由 start/end 派生；
 * - 教育项必须 school+degree、工作项必须 company+role，否则过滤（简历 Zod 要求非空）。
 */
export function localProfileToResumeFields(c: LocalProfileFields): LocalResumeFields {
  const clean = sanitizeLocalProfile(c);
  const out: LocalResumeFields = {};
  if (clean.fullName) out.fullName = clean.fullName;
  if (clean.email) out.email = clean.email;
  if (clean.phone) out.phone = clean.phone;
  if (clean.location) out.location = clean.location;
  const site = clean.personalSite ?? clean.linkedinUrl;
  if (site) out.personalSite = site;
  const education = (clean.education ?? [])
    .filter((e): e is LocalProfileEducation & { school: string; degree: string } => Boolean(e.degree))
    .map((e) => ({ school: e.school, degree: e.degree, period: formatRange(e.start, e.end) }));
  if (education.length) out.education = education;
  const workHistory = (clean.workHistory ?? [])
    .filter((w): w is LocalProfileWork & { company: string; role: string } => Boolean(w.role))
    .map((w) => ({ company: w.company, role: w.role, period: formatRange(w.start, w.end), detail: w.detail }));
  if (workHistory.length) out.workHistory = workHistory;
  return out;
}

/** canonical → ATS 填充形状；只保留 ATS 有槽位的字段，role→title，丢弃 fullName/personalSite/detail */
export function localProfileToAtsFields(c: LocalProfileFields): LocalAtsFields {
  const clean = sanitizeLocalProfile(c);
  const out: LocalAtsFields = {};
  if (clean.email) out.email = clean.email;
  if (clean.phone) out.phone = clean.phone;
  if (clean.location) out.location = clean.location;
  if (clean.linkedinUrl) out.linkedinUrl = clean.linkedinUrl;
  const education = (clean.education ?? []).map((e) => ({
    school: e.school,
    degree: e.degree,
    start: e.start,
    end: e.end,
  }));
  if (education.length) out.education = education;
  const experience = (clean.workHistory ?? []).map((w) => ({
    company: w.company,
    title: w.role,
    start: w.start,
    end: w.end,
  }));
  if (experience.length) out.experience = experience;
  return out;
}

/** 旧报告页简历补填（period 自由文本）→ canonical */
export function legacyResumeToLocalProfile(old: LocalResumeFields): LocalProfileFields {
  return sanitizeLocalProfile({
    fullName: old.fullName,
    email: old.email,
    phone: old.phone,
    location: old.location,
    personalSite: old.personalSite,
    education: (old.education ?? []).map((e) => ({ school: e.school, degree: e.degree, ...splitRange(e.period) })),
    workHistory: (old.workHistory ?? []).map((w) => ({
      company: w.company,
      role: w.role,
      detail: w.detail,
      ...splitRange(w.period),
    })),
  });
}

/** 旧扩展 ATS 补填（experience/title、start/end）→ canonical */
export function legacyAtsToLocalProfile(old: LocalAtsFields): LocalProfileFields {
  return sanitizeLocalProfile({
    email: old.email,
    phone: old.phone,
    location: old.location,
    linkedinUrl: old.linkedinUrl,
    education: (old.education ?? []).map((e) => ({
      school: e.school,
      degree: e.degree,
      start: e.start,
      end: e.end,
    })),
    workHistory: (old.experience ?? []).map((x) => ({
      company: x.company,
      role: x.title,
      start: x.start,
      end: x.end,
    })),
  });
}

/**
 * 合并多份 canonical（标量取首个非空，教育/工作数组拼接并按 school+degree / company+role
 * 去重保序）。当前各端本域只有一份 legacy，主要服务未来通道与迁移测试。
 */
export function mergeLocalProfile(...parts: Array<LocalProfileFields | null | undefined>): LocalProfileFields {
  const merged: LocalProfileFields = {};
  const eduKeys = new Set<string>();
  const workKeys = new Set<string>();
  const education: LocalProfileEducation[] = [];
  const workHistory: LocalProfileWork[] = [];
  for (const p of parts) {
    if (!p) continue;
    (['fullName', 'email', 'phone', 'location', 'personalSite', 'linkedinUrl'] as const).forEach((k) => {
      if (merged[k] === undefined && p[k]) merged[k] = p[k];
    });
    for (const e of p.education ?? []) {
      const key = `${(e.school ?? '').trim()}|${(e.degree ?? '').trim()}`;
      if (!eduKeys.has(key)) {
        eduKeys.add(key);
        education.push(e);
      }
    }
    for (const w of p.workHistory ?? []) {
      const key = `${(w.company ?? '').trim()}|${(w.role ?? '').trim()}`;
      if (!workKeys.has(key)) {
        workKeys.add(key);
        workHistory.push(w);
      }
    }
  }
  if (education.length) merged.education = education;
  if (workHistory.length) merged.workHistory = workHistory;
  return sanitizeLocalProfile(merged);
}

/**
 * 跨端本地档案同步消息协议（扩展 background ↔ 报告页 bridge）。
 * 报告页经 `chrome.runtime.sendMessage(EXTENSION_ID, msg)` 与扩展通信，扩展把 canonical
 * 档案镜像到 `chrome.storage.local[LOCAL_PROFILE_STORAGE_KEY]`（跨域权威）；两端本域
 * localStorage 仅作降级缓存。消息形状是纯数据、无 chrome 依赖，故落 shared 单一事实源。
 * 详见 design-targeted-resume §5.4.1 与 deferred-items「本地档案跨端自动同步」。
 */

/** 报告页 → 扩展：请求读取扩展侧 canonical 档案。 */
export const EXT_MSG_GET_LOCAL_PROFILE = 'jobagent:get-local-profile';
/** 报告页 → 扩展：请求写入扩展侧 canonical 档案（扩展与现有值合并后落 chrome.storage）。 */
export const EXT_MSG_SET_LOCAL_PROFILE = 'jobagent:set-local-profile';

export interface ExtGetLocalProfileMessage {
  type: typeof EXT_MSG_GET_LOCAL_PROFILE;
}
export interface ExtSetLocalProfileMessage {
  type: typeof EXT_MSG_SET_LOCAL_PROFILE;
  value: LocalProfileFields;
}
export type ExtLocalProfileRequest = ExtGetLocalProfileMessage | ExtSetLocalProfileMessage;

/** background 的统一响应：ok=false 表示扩展未装/出错；value 为合并后的 canonical 档案。 */
export interface ExtLocalProfileResponse {
  ok: boolean;
  value?: LocalProfileFields;
}

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
/** LLM 受约束润色溯源（B 档，设计 §7）：仅润色成功并通过校验时写入，保证可复现。 */
export const ResumePolishProvenanceSchema = z.object({
  provider: z.string().min(1), // LLM 提供方标识，如 'openai' / 'anthropic' / 'fake'
  model: z.string().min(1), // 模型 id
  promptVersion: z.string().min(1), // 提示词模板版本
  appliedAt: z.string().datetime(),
});
export type ResumePolishProvenance = z.infer<typeof ResumePolishProvenanceSchema>;

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
    // B 档 LLM 润色溯源；规则版（A 档）无此字段
    polish: ResumePolishProvenanceSchema.optional(),
  }),
});
export type ResumeDraft = z.infer<typeof ResumeDraftSchema>;

/** 解析简历草稿（对外统一入口；失败返回 null，由调用方决定降级） */
export function parseResumeDraft(input: unknown): ResumeDraft | null {
  const result = ResumeDraftSchema.safeParse(input);
  return result.success ? result.data : null;
}
