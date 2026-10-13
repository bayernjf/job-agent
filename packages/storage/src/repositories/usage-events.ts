/**
 * usage_events 仓储契约——成本回采/用量计量（决策 #25 ④ Wave A，迁移 038）。
 *
 * 写口只有 usage-recorder（只追加，永不 UPDATE/DELETE）；读口是聚合汇总，
 * 供后续 admin/owner 面（D agent）查询"哪个功能在烧钱"。本期只开接缝，
 * 不 mount 任何 HTTP 路由。
 *
 * 方言纪律：按自然日 bucket（SQLite date() vs PG 时间转换）只允许出现在
 * sqlite/postgres 实现内部，业务侧只看到 'YYYY-MM-DD' 字符串。
 */
import type {
  UsageDailyRow,
  UsageSummaryQuery,
  UsageSummaryRow,
} from '@jobagent/shared';
import type { UsageEventRecord } from '../entities/usage-event.js';

export interface IUsageEventsRepository {
  /** 追加一条用量事件（完整行含 id/created_at，由 recorder 注入） */
  insert(row: UsageEventRecord): Promise<void>;
  /**
   * 按 (category, feature, billing_source) 聚合窗口内事件。
   * sinceIso 含、untilIso 不含；accountId 省略＝全平台口径；category 可选过滤。
   * sum 对全 NULL 组返回 0（COALESCE）；排序确定（category/feature/billingSource 升序）。
   */
  summarize(query: UsageSummaryQuery): Promise<UsageSummaryRow[]>;
  /**
   * 按自然日（UTC 'YYYY-MM-DD'）+ category 聚合窗口内事件（日趋势，不细分
   * feature/billingSource）。过滤口径与 summarize 相同；按 day/category 升序。
   */
  summarizeDaily(query: UsageSummaryQuery): Promise<UsageDailyRow[]>;
}
