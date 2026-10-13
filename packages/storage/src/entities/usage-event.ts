import type {
  UsageBillingSource,
  UsageCategory,
  UsageFeature,
} from '@jobagent/shared';

/**
 * usage_events 实体：成本回采/用量计量事件（决策 #25 ④，迁移 038）。
 *
 * 一行 = 一次可计费功能调用的原始计量单位记录（token 数 / 次数，绝不记金额）。
 * 完整行（含 id/created_at）由 usage-recorder 注入后交仓储 insert；
 * 本表只追加，仓储不暴露 UPDATE/DELETE。类别值域由应用侧 Zod 守门，DB 无 CHECK。
 */
export interface UsageEventRecord {
  /** 事件主键：usg-<uuid>（recorder 生成，参考 job_run_events 的 evt- 惯例） */
  id: string;
  /** 触发账号；匿名/平台级事件为 null（不建外键，刻意不级联） */
  accountId: string | null;
  /** 成本大类：llm | search | analysis */
  category: UsageCategory;
  /** 功能点：cover_letter | resume_polish | jd_extraction | semantic_summary | websearch | analysis_job */
  feature: UsageFeature;
  /** 谁掏钱：builtin | byok | platform */
  billingSource: UsageBillingSource;
  /** 提供方标识（LLM provider 名 / tavily / github / gitee / all）；不适用为 null */
  provider: string | null;
  /** 模型标识（LLM 事件）；不适用为 null */
  model: string | null;
  /** 输入 token 数；非 LLM 事件为 null */
  promptTokens: number | null;
  /** 输出 token 数；非 LLM 事件为 null */
  completionTokens: number | null;
  /** 非 token 单位（Tavily 查询数、分析作业成本权重 1|2）；不适用为 null */
  quantity: number | null;
  /** 事件时刻（UTC ISO8601，recorder 注入） */
  createdAt: string;
}

/** Drizzle 查询返回的原始行（camelCase），两方言结构一致 */
export type RawUsageEventRow = UsageEventRecord;

export function toUsageEventRecord(row: RawUsageEventRow): UsageEventRecord {
  return { ...row };
}
