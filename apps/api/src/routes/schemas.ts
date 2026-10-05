/**
 * API 输入校验 Zod schemas（从原 index.ts 抽出，Q1 单文件拆分）。
 * 所有外部输入（body / query / param）一律经这里的 schema 校验。
 */
import { z } from 'zod';
import {
  JobSourceSchema,
  LocalResumeFieldsSchema,
  OutcomeFeedbackSchema,
  ResumeLocaleSchema,
} from '@jobagent/shared';
import {
  APPLICATION_STATUSES,
  APPLICATION_ORIGINS,
  type ApplicationOrigin,
  type ApplicationStatus,
} from '@jobagent/storage';

export const AnalyzeRequestSchema = z.object({
  username: z
    .string()
    .min(1, 'username is required')
    .max(39, 'username too long')
    // 兼容 GitHub（字母数字+中划线）与 Gitee（额外允许下划线）
    .regex(/^[a-zA-Z0-9](?:[a-zA-Z0-9]|[-_](?=[a-zA-Z0-9]))*$/, 'invalid username format'),
  // all=一次作业同时采 GitHub+Gitee 并镜像去重融合成一张画像（见 design-cross-source-fusion §8）
  platform: z.enum(['github', 'gitee', 'all']).default('github'),
});

export const JobIdParamSchema = z.object({
  id: z.string().min(1, 'job id is required'),
});

export const ProfileIdParamSchema = z.object({
  id: z.string().min(1, 'profile id is required'),
});

// 岗位搜索 query string 校验（全是字符串，需逐项转换）
export const JobSearchQuerySchema = z.object({
  keyword: z.string().trim().min(1).optional(),
  remote: z.enum(['true', 'false']).optional(),
  sources: z.string().trim().min(1).optional(), // 逗号分隔，逐个用 JobSourceSchema 校验
  company: z.string().trim().min(1).optional(),
  tags: z.string().trim().min(1).optional(),
  salaryMinUsd: z.coerce.number().int().nonnegative().optional(),
  postedAfter: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().positive().max(500).optional(),
  offset: z.coerce.number().int().nonnegative().optional(),
  orderBy: z.enum(['posted_desc', 'posted_asc', 'salary_desc']).optional(),
});

// 画像匹配请求体：skills 与 profileId 二选一（profileId 优先，从画像快照取 skillTags.name）
export const JobMatchRequestSchema = z.object({
  skills: z.array(z.string().trim().min(1)).optional(),
  profileId: z.string().trim().min(1).optional(),
  remote: z.boolean().optional(),
  salaryMinUsd: z.number().int().nonnegative().optional(),
  sources: z.array(JobSourceSchema).optional(),
  keyword: z.string().trim().min(1).optional(),
  tags: z.array(z.string().trim().min(1)).optional(),
  company: z.string().trim().min(1).optional(),
  postedAfter: z.string().trim().min(1).optional(),
  candidateLimit: z.number().int().positive().max(500).optional(),
  limit: z.number().int().positive().max(500).optional(),
  /** T20 翻页：跳过前 offset 条去重后的匹配（默认 0） */
  offset: z.number().int().nonnegative().optional(),
}).refine((d) => (d.skills && d.skills.length > 0) || !!d.profileId, {
  message: 'either non-empty skills or profileId is required',
  path: ['skills'],
});

// 岗位定向简历生成请求体（P-R2）：画像 + 岗位 + 可选本地补填；服务端不持久化、不记日志。
/** T24② 自选岗位：用户粘贴 JD 直传（不入池、不落库），最小只需岗位名 + JD 文本 */
export const ManualPostingSchema = z.object({
  title: z.string().trim().min(1, 'title is required').max(300),
  description: z.string().trim().min(1, 'JD text is required').max(20000),
  company: z.string().trim().max(200).optional(),
});

export const ResumeBuildRequestSchema = z
  .object({
    profileId: z.string().min(1, 'profileId is required'),
    // T24② 岗位来源二选一：池子里的 jobId，或用户粘贴 JD 直传（source=manual，复用既有匹配链路）
    jobId: z.string().min(1).optional(),
    posting: ManualPostingSchema.optional(),
    // 画像不提供的教育/工作经历/联系方式；仅用于本次渲染，绝不入库或落日志（设计 §5.4）
    local: LocalResumeFieldsSchema.optional(),
    locale: ResumeLocaleSchema.optional(),
    format: z.enum(['json', 'md', 'html']).optional(), // 默认 json（仅结构化草稿）
    highlightLimit: z.number().int().positive().max(50).optional(),
    // 是否请求 B 档 LLM 措辞润色（设计 §7）：默认 false 走纯规则版；true 且服务端未配置/润色被安全层拒绝时，
    // 静默回退规则版，并在响应 polish.applied=false + reason 中如实标注，绝不臆造、绝不因润色失败而报错。
    polish: z.boolean().optional(),
  })
  .refine((d) => Boolean(d.jobId) !== Boolean(d.posting), {
    message: 'exactly one of jobId or posting is required',
  });

// 求职信生成请求体（A 档，2026-10-03）：画像 + 岗位 + 可选本地补填；
// 仅登录 user 可调（LLM 付费），产物不入库、不记日志，失败如实报错不伪造。
export const CoverLetterRequestSchema = z
  .object({
    profileId: z.string().min(1, 'profileId is required'),
    jobId: z.string().min(1).optional(),
    posting: ManualPostingSchema.optional(),
    locale: ResumeLocaleSchema.optional(),
    local: LocalResumeFieldsSchema.optional(),
  })
  .refine((d) => Boolean(d.jobId) !== Boolean(d.posting), {
    message: 'exactly one of jobId or posting is required',
  });

// ── 企业侧人才检索（筛选工作台 P-A/P-B）──────────────────────────────────
// 全是 query string（字符串），枚举集合/数字在 handler 内逐项转换校验。
export const CandidateSearchQuerySchema = z.object({
  keyword: z.string().trim().min(1).optional(),
  skills: z.string().trim().min(1).optional(), // 逗号分隔技能名
  skillMatch: z.enum(['any', 'all']).optional(),
  authenticity: z.string().trim().min(1).optional(), // 逗号分隔真实性状态
  minConfidence: z.coerce.number().min(0).max(1).optional(),
  platform: z.enum(['github', 'gitee']).optional(),
  sortBy: z.enum(['confidence_desc', 'skill_count_desc', 'recent']).optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
  offset: z.coerce.number().int().nonnegative().optional(),
});

// ── 投递记录（applications，痛点解决方案批次 2）────────────────────────────
export const ApplicationStatusSchema = z.enum(
  APPLICATION_STATUSES as unknown as [ApplicationStatus, ...ApplicationStatus[]],
);
export const ApplicationOriginSchema = z.enum(
  APPLICATION_ORIGINS as unknown as [ApplicationOrigin, ...ApplicationOrigin[]],
);

export const ApplicationCreateSchema = z.object({
  jobId: z.string().min(1).nullish(),
  source: z.string().min(1).nullish(),
  targetTitle: z.string().min(1, 'targetTitle is required'),
  targetCompany: z.string().min(1, 'targetCompany is required'),
  targetUrl: z.string().url().nullish(),
  status: ApplicationStatusSchema.optional(),
  note: z.string().nullish(),
  origin: ApplicationOriginSchema.optional(),
  appliedAt: z.string().datetime().optional(),
});

export const ApplicationPatchSchema = z
  .object({
    status: ApplicationStatusSchema.optional(),
    note: z.string().nullable().optional(),
    appliedAt: z.string().datetime().optional(),
    targetUrl: z.string().url().nullable().optional(),
    /**
     * 投递结果回标。item126：写口从"只有票据一条路"放开到任意投递行，
     * 于是 manual / report / extension 三种来源也能进复盘样本（决策 #20-3 的前提）。
     * 时间戳由服务端盖，不接受调用者自填——否则"何时知道结果"这个维度可被伪造。
     * 有意**不开放 null**：仓储契约就写着"清除走专门流程，此处不开放"，而那个流程至今不存在，
     * 所以这里只做设置/覆盖（标错可以改成另一个值），不把"退回未记录"塞进止血里。
     */
    outcomeFeedback: OutcomeFeedbackSchema.optional(),
  })
  .refine((d) => Object.keys(d).length > 0, {
    message: 'at least one field to update is required',
  });

// GET /profiles/by-subject 的 param 校验
export const SubjectLookupParamSchema = z.object({
  platform: z.enum(['github', 'gitee']), // platform=all 是双源作业参数，不存在单一主体快照
  login: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, 'login must start with an alphanumeric'),
});

// POST /profiles/:id/removal-request 的 body 校验
export const RemovalRequestBodySchema = z.object({
  reason: z.string().trim().max(2000).optional(),
  contact: z.string().trim().max(500).optional(),
});

// POST /profiles/:id/claim-verifications 的 body 校验（决策 #23 批次 2）。
// 只收"一条结构化声明"的原文与可选来源定位；claim_source 由服务端固定为 manual
// （resume_import 属未获批的 A 导入器），判定结果一律由内核算出，不接受调用者指定。
export const ClaimVerificationCreateSchema = z.object({
  text: z.string().trim().min(1, 'claim text is required').max(2000),
  claimRef: z.string().trim().min(1).max(500).optional(),
});
