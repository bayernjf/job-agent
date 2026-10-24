/**
 * 证据项与真实性信号契约（从 index.ts 拆出，审查动作 #8）。
 * 证据源无关：GitHub/Gitee 只是不同的 EvidenceItem.source。
 */
import { z } from 'zod';

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

/**
 * 信号结构化事实（T33）：生产者为每个信号附上"可由 API 直接得到的计数/比值"，
 * 渲染侧按 code+facts 现拼读者语言句子，不再依赖 label/detail 的英文原文做展示。
 * 键名由 signals.ts 的生产者定义；composeSignalDetail 按 code 消费，缺键退回原文。
 */
export const SignalFactsSchema = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean()]),
);
export type SignalFacts = z.infer<typeof SignalFactsSchema>;

export const AuthenticitySignalSchema = z.object({
  code: z.string().min(1), // 规则/模型信号码，带版本
  severity: SignalSeveritySchema,
  label: z.string().min(1), // 人话标题（数据层英文原文，全链路存档/API 以此为准）
  detail: z.string().min(1), // 具体描述（数据层英文原文；渲染侧优先 facts 现拼）
  evidenceRefs: z.array(z.string().min(1)), // -> EvidenceItem.evidenceId
  facts: SignalFactsSchema.optional(), // T33：结构化计数，渲染侧 i18n 现拼的输入
});
export type AuthenticitySignal = z.infer<typeof AuthenticitySignalSchema>;

/** 规则化面试题的种类（T33）：渲染分支与意图文案按 kind 取，不按英文 question 匹配 */
export const InterviewQuestionKindSchema = z.enum([
  'self_repo_depth', // 自建仓库的维护深度
  'external_pr', // 被他人项目 merge 的 PR（协作）
  'high_star_design', // 高 star 自建仓库的系统设计
  'language_depth', // 主要语言深度
  'issue_diagnosis', // Issue 诊断能力
]);
export type InterviewQuestionKind = z.infer<typeof InterviewQuestionKindSchema>;

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
