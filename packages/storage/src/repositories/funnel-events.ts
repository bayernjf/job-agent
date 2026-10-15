import type {
  FunnelDailyRow,
  FunnelSummaryQuery,
  FunnelSummaryRow,
} from '@jobagent/shared';
import type { FunnelEventRecord } from '../entities/funnel-event.js';

/**
 * funnel_events 仓储（迁移 040，design-funnel-analytics-20261015）。
 * 只追加，不回改：无 UPDATE/DELETE 口。方言差异只允许出现在实现内部。
 */
export interface IFunnelEventsRepository {
  /** 追加一条漏斗事件（id/createdAt 已由 recorder 注入） */
  insert(row: FunnelEventRecord): Promise<void>;

  /**
   * 报告查看写入（30 分钟去重，设计 §5.1）：同一 (sessionRef, profileId)
   * 在 dedupeWindowMs 内已有 report_viewed 则跳过插入返回 'deduped'；
   * sessionRef 为 null 时不去重直插（NULL 组占比在汇总读数里单独看）。
   */
  recordView(row: FunnelEventRecord, dedupeWindowMs: number): Promise<'inserted' | 'deduped'>;

  /** 按事件聚合：总次数 + 去重会话数（COUNT DISTINCT session_ref）+ 无会话标识次数 */
  summarize(query: FunnelSummaryQuery): Promise<FunnelSummaryRow[]>;

  /** 按自然日（UTC）× 事件分组的每日趋势 */
  summarizeDaily(query: FunnelSummaryQuery): Promise<FunnelDailyRow[]>;
}
