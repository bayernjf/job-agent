import { and, asc, eq, gte, lt, sql, type SQL } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
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

/** usage_events 仓储的 SQLite 实现（异步接口、同步驱动）。只追加，不回改。 */
export class SqliteUsageEventsRepository implements IUsageEventsRepository {
  constructor(private readonly db: BetterSQLite3Database) {}

  async insert(row: UsageEventRecord): Promise<void> {
    this.db.insert(t).values(row).run();
  }

  async summarize(query: UsageSummaryQuery): Promise<UsageSummaryRow[]> {
    const rows = this.db
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
      .orderBy(asc(t.category), asc(t.feature), asc(t.billingSource))
      .all() as RawSummaryRow[];
    return rows.map(toSummaryRow);
  }

  async summarizeDaily(query: UsageSummaryQuery): Promise<UsageDailyRow[]> {
    // created_at 是 UTC ISO8601（带 Z 后缀），SQLite date() 按 UTC 归并自然日。
    // select 里必须 .as('day') 才能映射回字段；但 SQLite 方言的 groupBy/orderBy
    // 类型不收 SQL.Aliased（PG 收 SQLWrapper），所以分组/排序用未别名表达式。
    const daySelect = sql<string>`date(${t.createdAt})`.as('day');
    const dayGroup = sql`date(${t.createdAt})`;
    const rows = this.db
      .select({
        day: daySelect,
        category: t.category,
        events: sql<number>`count(*)`,
        sumPromptTokens: sql<number>`COALESCE(sum(${t.promptTokens}), 0)`,
        sumCompletionTokens: sql<number>`COALESCE(sum(${t.completionTokens}), 0)`,
        sumQuantity: sql<number>`COALESCE(sum(${t.quantity}), 0)`,
      })
      .from(t)
      .where(and(...this.filters(query)))
      .groupBy(dayGroup, t.category)
      .orderBy(asc(dayGroup), asc(t.category))
      .all() as RawDailyRow[];
    return rows.map(toDailyRow);
  }

  /** sinceIso 含、untilIso 不含；accountId/category 省略＝不加该过滤。 */
  private filters(query: UsageSummaryQuery): SQL[] {
    const f: SQL[] = [gte(t.createdAt, query.sinceIso)];
    if (query.untilIso !== undefined) f.push(lt(t.createdAt, query.untilIso));
    if (query.accountId !== undefined) f.push(eq(t.accountId, query.accountId));
    if (query.category !== undefined) f.push(eq(t.category, query.category));
    return f;
  }
}
