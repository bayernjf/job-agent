import { and, asc, eq, isNull, sql, type SQL } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type {
  FunnelDailyRow,
  FunnelEventName,
  FunnelSummaryQuery,
  FunnelSummaryRow,
} from '@jobagent/shared';
import type { FunnelEventRecord } from '../entities/index.js';
import type { IFunnelEventsRepository } from '../repositories/funnel-events.js';
import { tsGte, tsLt } from './time-text.js';
import { funnelEvents as t } from './schema.js';

/** 聚合 select 的原始行（文本列经 Zod 值域写入，读侧在 map 处收窄为字面量联合）。 */
interface RawSummaryRow {
  event: string;
  events: number;
  distinctSessions: number;
  nullSessions: number;
}

interface RawDailyRow {
  day: string;
  event: string;
  events: number;
}

// Postgres returns aggregate columns (count/sum over int8/numeric) as string or BigInt,
// while SQLite returns numbers. Coerce everything to number here so the row shape matches
// FunnelSummaryRowSchema (all z.number()) regardless of the driver.
function toNumber(value: unknown): number {
  return typeof value === 'number' ? value : Number(value);
}

function toSummaryRow(r: RawSummaryRow): FunnelSummaryRow {
  return {
    event: r.event as FunnelEventName,
    events: toNumber(r.events),
    distinctSessions: toNumber(r.distinctSessions),
    nullSessions: toNumber(r.nullSessions),
  };
}

function toDailyRow(r: RawDailyRow): FunnelDailyRow {
  return {
    day: r.day,
    event: r.event as FunnelEventName,
    events: toNumber(r.events),
  };
}

/** funnel_events 仓储的 Postgres 实现（全异步）。只追加，不回改。 */
export class PgFunnelEventsRepository implements IFunnelEventsRepository {
  constructor(private readonly db: PostgresJsDatabase) {}

  async insert(row: FunnelEventRecord): Promise<void> {
    await this.db.insert(t).values(row);
  }

  async recordView(
    row: FunnelEventRecord,
    dedupeWindowMs: number,
  ): Promise<'inserted' | 'deduped'> {
    // 30 分钟 (session_ref, profile_id) 去重（设计 §5.1）；sessionRef 为 null 不去重直插。
    if (row.sessionRef !== null) {
      const sinceIso = new Date(Date.parse(row.createdAt) - dedupeWindowMs).toISOString();
      const conds: SQL[] = [
        eq(t.event, 'report_viewed'),
        eq(t.sessionRef, row.sessionRef),
        tsGte(t.createdAt, sinceIso),
        row.profileId !== null ? eq(t.profileId, row.profileId) : isNull(t.profileId),
      ];
      const existing = await this.db
        .select({ id: t.id })
        .from(t)
        .where(and(...conds))
        .limit(1);
      if (existing.length > 0) return 'deduped';
    }
    await this.db.insert(t).values(row);
    return 'inserted';
  }

  async summarize(query: FunnelSummaryQuery): Promise<FunnelSummaryRow[]> {
    // COUNT(DISTINCT session_ref) 在 SQLite/PG 都忽略 NULL；NULL 组用 CASE WHEN 单独数。
    const rows = (await this.db
      .select({
        event: t.event,
        events: sql<number>`count(*)`,
        distinctSessions: sql<number>`count(distinct ${t.sessionRef})`,
        nullSessions: sql<number>`COALESCE(sum(CASE WHEN ${t.sessionRef} IS NULL THEN 1 ELSE 0 END), 0)`,
      })
      .from(t)
      .where(and(...this.filters(query)))
      .groupBy(t.event)
      .orderBy(asc(t.event))) as RawSummaryRow[];
    return rows.map(toSummaryRow);
  }

  async summarizeDaily(query: FunnelSummaryQuery): Promise<FunnelDailyRow[]> {
    // 列是 TEXT：显式 ::timestamptz 后按 UTC 取日历日（to_char 直接给 YYYY-MM-DD）。
    const dayExpr = sql<string>`to_char(${t.createdAt}::timestamptz AT TIME ZONE 'UTC', 'YYYY-MM-DD')`.as(
      'day',
    );
    const rows = (await this.db
      .select({
        day: dayExpr,
        event: t.event,
        events: sql<number>`count(*)`,
      })
      .from(t)
      .where(and(...this.filters(query)))
      .groupBy(dayExpr, t.event)
      .orderBy(asc(dayExpr), asc(t.event))) as RawDailyRow[];
    return rows.map(toDailyRow);
  }

  /**
   * sinceIso 含、untilIso 不含。
   * 时间比较走 time-text 的 ::text 钉型，避免事务池化串下参数被推断成
   * timestamptz 导致 42883（见 postgres/time-text.ts）。
   */
  private filters(query: FunnelSummaryQuery): SQL[] {
    const f: SQL[] = [tsGte(t.createdAt, query.sinceIso)];
    if (query.untilIso !== undefined) f.push(tsLt(t.createdAt, query.untilIso));
    return f;
  }
}
