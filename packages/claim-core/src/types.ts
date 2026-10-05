/**
 * 逐条声明核验的契约（决策 #23，design-claim-verification-20261005.md）。
 *
 * 硬约束直接搬到类型上，防止后来者不小心破坏：
 * 1. **三态判定优先于分数**：verdict 只有四个取值，没有"造假概率"这类连续量；
 *    `confidence` 是"支撑强度"，不是"真实度百分比"。
 * 2. **输出只给 code + facts**：不存为了渲染而拼好的句子（句子由渲染侧按 locale 现拼），
 *    因此这里没有任何自然语言字段。
 * 3. **判定不回写画像**：输入是只读的画像快照，输出是一个全新的独立对象。这条混淆一旦发生，
 *    同一份快照就会有两种语义，分享链接的可复现性随之失效。
 */
import { z } from 'zod';

/** 只承认这四个取值；`insufficient_data` 与 `no_trace` 的区分是产品的核心口径 */
export const CLAIM_VERDICTS = ['supportable', 'partial', 'no_trace', 'insufficient_data'] as const;
export const ClaimVerdictSchema = z.enum(CLAIM_VERDICTS);
export type ClaimVerdict = z.infer<typeof ClaimVerdictSchema>;

export const CLAIM_SOURCES = ['manual', 'resume_import'] as const;
export const ClaimSourceSchema = z.enum(CLAIM_SOURCES);
export type ClaimSource = z.infer<typeof ClaimSourceSchema>;

/**
 * 为什么这条判定是这个结论。
 * 渲染侧**只认这些 code**，绝不按英文句子或标签匹配（AGENTS「内核散文的语言归属」规则 ①）。
 */
export const CLAIM_REASON_CODES = [
  'explicit_ref_hit', // 声明里写了明确的仓库/PR/Issue 指针，且在画像证据里查到了
  'token_skill_tag', // 技能 token 命中画像技能标签且证据条数足够
  'token_weak_support', // 命中了，但支撑证据不够
  'no_matching_evidence', // 有可核验 token，但画像里确实没有对应证据
  'no_checkable_token', // 抽不出可核验 token（抽象能力类声明）——不是"没做过"
] as const;
export const ClaimReasonCodeSchema = z.enum(CLAIM_REASON_CODES);
export type ClaimReasonCode = z.infer<typeof ClaimReasonCodeSchema>;

/** 待核验的一条声明（结构化输入 B：人填或将来由导入器预填，落到同一张表、同一套规则） */
export const ClaimInputSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1), // 数据层原文
  source: ClaimSourceSchema,
  claimRef: z.string().min(1).optional(), // 导入时的页/条目定位，仅供复核
});
export type ClaimInput = z.infer<typeof ClaimInputSchema>;

/** 可用于回溯的证据行（`EvidenceItem` 的最小充分子集，够走 `evidenceRefs`） */
export const ClaimEvidenceSchema = z.object({
  evidenceId: z.string().min(1),
  url: z.string().url(),
  rawRef: z.string().min(1),
  sourceType: z.string().min(1),
  claim: z.string().min(1),
});
export type ClaimEvidence = z.infer<typeof ClaimEvidenceSchema>;

/** 判定依据用到的画像事实（刻意只要子集：内核不许碰也不需要整份快照） */
export const ClaimProfileFactsSchema = z.object({
  skillTags: z.array(
    z.object({
      name: z.string().min(1),
      kind: z.enum(['language', 'framework', 'domain']),
      depth: z.enum(['used', 'proficient']),
      confidence: z.number().min(0).max(1),
      evidenceRefs: z.array(z.string().min(1)),
    }),
  ),
});
export type ClaimProfileFacts = z.infer<typeof ClaimProfileFactsSchema>;

/** 渲染侧按 code + facts 现拼句子的输入；这里一律是结构性事实，不含散文 */
export const ClaimFactsSchema = z.object({
  /** 抽到的可核验 token（词典规范名） */
  tokens: z.array(z.string()),
  /** 命中的技能标签名 */
  skillTagNames: z.array(z.string()),
  /** 声明里显式写出的指针（原文片段），用于在真正写入前给人复核 */
  explicitRefs: z.array(z.string()),
  /** 支撑这条声明的证据条数（去重后，且必须在给定证据列表里真实存在） */
  evidenceCount: z.number().int().nonnegative(),
  /** 判定为 supportable 所需的最少证据条数，写进 facts 让 UI 能解释"差多少" */
  requiredEvidenceCount: z.number().int().positive(),
});
export type ClaimFacts = z.infer<typeof ClaimFactsSchema>;

export const ClaimAssessmentSchema = z.object({
  claimId: z.string().min(1),
  verdict: ClaimVerdictSchema,
  code: ClaimReasonCodeSchema,
  /** 支撑强度，非"造假概率"；`insufficient_data` 与 `no_trace` 一律为 null */
  confidence: z.number().min(0).max(1).nullable(),
  /** 可直接点开回溯的证据 id（no_trace / insufficient_data 时为空数组） */
  evidenceIds: z.array(z.string().min(1)),
  facts: ClaimFactsSchema,
  ruleVersion: z.string().min(1),
});
export type ClaimAssessment = z.infer<typeof ClaimAssessmentSchema>;
