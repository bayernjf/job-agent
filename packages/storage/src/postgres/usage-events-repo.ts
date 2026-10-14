import { and, asc, eq, sql, type SQL } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type {
  UsageBillingSource,
  UsageCategory,
  UsageDailyRow,
  UsageFeature,
  UsageSummaryQuery,
  UsageSummaryRow,
} from '@jobagent/shared';
import type { UsageEventRecord } from '../entities/index.js';
import type { IUsageEventsRepository } from '../repositories/usage-events.js';
import { tsGte, tsLt } from './time-text.js';
import { usageEvents as t } from './schema.js';

/** 聚合 select 的原始行（文本列经 Zod 值域写入，读侧在 map 处收窄为字面量联合）。 */
interface RawSummaryRow {
  category: string;
  feature: string;
  billingSource: string;
  events: number;
  sumPromptTokens: number;
  sumCompletionTokens: number;
  sumQuantity: number;
}

interface RawDailyRow {
  day: string;
  category: string;
  events: number;
  sumPromptTokens: number;
  sumCompletionTokens: number;
  sumQuantity: number;
}

// Postgres returns aggregate columns (count/sum over int8/numeric) as string or BigInt,
// while SQLite returns numbers. Coerce everything to number here so the row shape matches
// UsageSummaryRowSchema (all z.number()) regardless of the driver.
function toNumber(value: unknown): number {
  return typeof value === 'number' ? value : Number(value);
}

function toSummaryRow(r: RawSummaryRow): UsageSummaryRow {
  return {
    category: r.category as UsageCategory,
    feature: r.feature as UsageFeature,
    billingSource: r.billingSource as UsageBillingSource,
    events: toNumber(r.events),
    sumPromptTokens: toNumber(r.sumPromptTokens),
    sumCompletionTokens: toNumber(r.sumCompletionTokens),
    sumQuantity: toNumber(r.sumQuantity),
  };
}

function toDailyRow(r: RawDailyRow): UsageDailyRow {
  return {
    day: r.day,
    category: r.category as UsageCategory,
    events: toNumber(r.events),
    sumPromptTokens: toNumber(r.sumPromptTokens),
    sumCompletionTokens: toNumber(r.sumCompletionTokens),
    sumQuantity: toNumber(r.sumQuantity),
  };
}

/** usage_events 仓储的 Postgres 实现（全异步）。只追加，不回改。 */
export class PgUsageEventsRepository implements IUsageEventsRepository {
  constructor(private readonly db: PostgresJsDatabase) {}

  async insert(row: UsageEventRecord): Promise<void> {
    await this.db.insert(t).values(row);
  }

  async summarize(query: UsageSummaryQuery): Promise<UsageSummaryRow[]> {
    const rows = (await this.db
      .select({
        category: t.category,
        feature: t.feature,
        billingSource: t.billingSource,
        events: sql<number>`count(*)`,
        sumPromptTokens: sql<number>`COALESCE(sum(${t.promptTokens}), 0)`,
        sumCompletionTokens: sql<number>`COALESCE(sum(${t.completionTokens}), 0)`,
        sumQuantity: sql<number>`COALESCE(sum(${t.quantity}), 0)`,
      })
      .from(t)
      .where(and(...this.filters(query)))
      .groupBy(t.category, t.feature, t.billingSource)
      .orderBy(asc(t.category), asc(t.feature), asc(t.billingSource))) as RawSummaryRow[];
    return rows.map(toSummaryRow);
  }

  async summarizeDaily(query: UsageSummaryQuery): Promise<UsageDailyRow[]> {
    // 列是 TEXT：显式 ::timestamptz 后按 UTC 取日历日（to_char 直接给 YYYY-MM-DD）。
    const dayExpr = sql<string>`to_char(${t.createdAt}::timestamptz AT TIME ZONE 'UTC', 'YYYY-MM-DD')`.as(
      'day',
    );
    const rows = (await this.db
      .select({
        day: dayExpr,
        category: t.category,
        events: sql<number>`count(*)`,
        sumPromptTokens: sql<number>`COALESCE(sum(${t.promptTokens}), 0)`,
        sumCompletionTokens: sql<number>`COALESCE(sum(${t.completionTokens}), 0)`,
        sumQuantity: sql<number>`COALESCE(sum(${t.quantity}), 0)`,
      })
      .from(t)
      .where(and(...this.filters(query)))
      .groupBy(dayExpr, t.category)
      .orderBy(asc(dayExpr), asc(t.category))) as RawDailyRow[];
    return rows.map(toDailyRow);
  }

  /**
   * sinceIso 含、untilIso 不含；accountId/category 省略＝不加该过滤。
   * 时间比较走 time-text 的 ::text 钉型，避免事务池化串下参数被推断成
   * timestamptz 导致 42883（见 postgres/time-text.ts）。
   */
  private filters(query: UsageSummaryQuery): SQL[] {
    const f: SQL[] = [tsGte(t.createdAt, query.sinceIso)];
    if (query.untilIso !== undefined) f.push(tsLt(t.createdAt, query.untilIso));
    if (query.accountId !== undefined) f.push(eq(t.accountId, query.accountId));
    if (query.category !== undefined) f.push(eq(t.category, query.category));
    return f;
  }
}
