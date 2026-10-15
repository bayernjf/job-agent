import type { FunnelEventName, FunnelRequester } from '@jobagent/shared';

/**
 * funnel_events 表实体（迁移 040，design-funnel-analytics-20261015）。
 * append-only 匿名漏斗事件；隐私硬约束：不记账号 id / IP / 被分析用户名 / UA。
 */
export interface FunnelEventRecord {
  /** 事件主键（fe-<uuid>，由 recorder 生成） */
  id: string;
  /** 漏斗步骤（analyze_enqueued | analyze_cache_hit | report_viewed | share_clicked） */
  event: FunnelEventName;
  /** 匿名会话标识（24h ja_sid cookie）；非浏览器来源为 null */
  sessionRef: string | null;
  /** 关联画像 uuid；仅 report_viewed / share_clicked 可带，无 FK */
  profileId: string | null;
  /** 触发者口径（user | demo | visitor）；不适用为 null */
  requester: FunnelRequester | null;
  /** 事件时间（UTC ISO8601，由 recorder 注入） */
  createdAt: string;
}

/** Drizzle schema 已完成 snake_case ↔ camelCase 列名映射，原始行与记录同形 */
export type RawFunnelEventRow = FunnelEventRecord;

export function toFunnelEventRecord(row: RawFunnelEventRow): FunnelEventRecord {
  return { ...row };
}
