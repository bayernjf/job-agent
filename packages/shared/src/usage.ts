import { z } from 'zod';

/**
 * 成本回采/用量计量契约（决策 #25 ④「自建 JD 上线后启动成本回采」，Wave A 地基）。
 *
 * 目的只有一个：回答"哪个功能在烧钱"（内置 LLM token、Tavily 付费搜岗、分析作业算力），
 * 不是定价。全表是只追加事件日志，记录**原始单位**（token 数 / 次数），绝不记金额。
 *
 * 本文件是单一事实源：类型由 Zod schema 派生（z.infer），storage 仓储、API 校验、
 * worker/recorder 全链路共用。类别演进只在这里与应用侧 Zod 守门，DB 层不加 CHECK。
 */

/** 成本大类：LLM 调用 / 付费搜索 / 分析作业算力 */
export const USAGE_CATEGORIES = ['llm', 'search', 'analysis'] as const;
export const UsageCategorySchema = z.enum(USAGE_CATEGORIES);
export type UsageCategory = z.infer<typeof UsageCategorySchema>;

/** 具体功能点（与 category 多对一；新增功能点时在此扩枚举） */
export const USAGE_FEATURES = [
  'cover_letter', // LLM 求职信生成
  'resume_polish', // LLM 简历润色
  'jd_extraction', // LLM JD 抽取（求职 Agent C1）
  'semantic_summary', // L3-B LLM 语义摘要
  'websearch', // Tavily 指令式全网搜岗
  'analysis_job', // 分析作业（平台算力，按作业成本权重 1|2）
] as const;
export const UsageFeatureSchema = z.enum(USAGE_FEATURES);
export type UsageFeature = z.infer<typeof UsageFeatureSchema>;

/**
 * 谁掏钱的三分口径：
 * - builtin：平台付费（内置 LLM，env LLM_* 凭证）
 * - byok：用户自带 key（平台不掏钱，但仍计用量——要看功能被用了多少次）
 * - platform：平台基础设施消耗（Tavily 查询、分析作业算力等非 LLM 成本）
 */
export const USAGE_BILLING_SOURCES = ['builtin', 'byok', 'platform'] as const;
export const UsageBillingSourceSchema = z.enum(USAGE_BILLING_SOURCES);
export type UsageBillingSource = z.infer<typeof UsageBillingSourceSchema>;

/** 非负整数字段：缺省/不适用为 null（由调用方显式给 null，而非 undefined 入库） */
const nullableNonNegativeInt = z.number().int().nonnegative().nullable();

/**
 * 记录一条用量事件的输入（recorder 入参）。
 * id 与 created_at 不在此结构内——由 recorder 注入（usg-<uuid> / UTC ISO8601）。
 */
export const RecordUsageInputSchema = z.object({
  /** 触发账号；匿名/平台级事件显式给 null（全平台口径仍可回采） */
  accountId: z.string().min(1).nullable(),
  category: UsageCategorySchema,
  feature: UsageFeatureSchema,
  billingSource: UsageBillingSourceSchema,
  /** 提供方标识：LLM provider 名 / tavily / github / gitee / all；不适用给 null */
  provider: z.string().min(1).nullable().optional(),
  /** 模型标识（LLM 类事件）；不适用给 null */
  model: z.string().min(1).nullable().optional(),
  /** 输入 token 数（LLM 类事件） */
  promptTokens: nullableNonNegativeInt.optional(),
  /** 输出 token 数（LLM 类事件） */
  completionTokens: nullableNonNegativeInt.optional(),
  /**
   * 非 token 计量单位的次数/权重：Tavily 查询数、分析作业成本权重（单源 1 / 双源融合 2）。
   */
  quantity: nullableNonNegativeInt.optional(),
});
export type RecordUsageInput = z.infer<typeof RecordUsageInputSchema>;

/** 汇总查询窗口（读侧）；accountId 省略＝全平台口径（admin/owner CLI）。 */
export const UsageSummaryQuerySchema = z.object({
  /** 起始时刻（含，UTC ISO8601） */
  sinceIso: z.string().min(1),
  /** 截止时刻（不含，UTC ISO8601）；省略＝至今 */
  untilIso: z.string().min(1).optional(),
  /** 只看某账号；省略＝全平台 */
  accountId: z.string().min(1).optional(),
  /** 大类过滤；省略＝全部大类 */
  category: UsageCategorySchema.optional(),
});
export type UsageSummaryQuery = z.infer<typeof UsageSummaryQuerySchema>;

/**
 * 按 (category, feature, billing_source) 分组的汇总行。
 * 各 sum 恒为数字（组内全 NULL 时为 0，由仓储 COALESCE 兜底）。
 */
export const UsageSummaryRowSchema = z.object({
  category: UsageCategorySchema,
  feature: UsageFeatureSchema,
  billingSource: UsageBillingSourceSchema,
  events: z.number().int().nonnegative(),
  sumPromptTokens: z.number().int().nonnegative(),
  sumCompletionTokens: z.number().int().nonnegative(),
  sumQuantity: z.number().int().nonnegative(),
});
export type UsageSummaryRow = z.infer<typeof UsageSummaryRowSchema>;

/**
 * 按自然日（UTC，'YYYY-MM-DD'）+ category 分组的每日汇总行。
 * 不细分 feature/billing_source——日趋势只看大类曲线。
 */
export const UsageDailyRowSchema = z.object({
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  category: UsageCategorySchema,
  events: z.number().int().nonnegative(),
  sumPromptTokens: z.number().int().nonnegative(),
  sumCompletionTokens: z.number().int().nonnegative(),
  sumQuantity: z.number().int().nonnegative(),
});
export type UsageDailyRow = z.infer<typeof UsageDailyRowSchema>;
