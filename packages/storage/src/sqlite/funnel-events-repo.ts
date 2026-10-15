import { and, asc, eq, gte, isNull, lt, sql, type SQL } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type {
  FunnelDailyRow,
  FunnelEventName,
  FunnelSummaryQuery,
  FunnelSummaryRow,
} from '@jobagent/shared';
import type { FunnelEventRecord } from '../entities/index.js';
import type { IFunnelEventsRepository } from '../repositories/funnel-events.js';
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

/** funnel_events 仓储的 SQLite 实现（异步接口、同步驱动）。只追加，不回改。 */
export class SqliteFunnelEventsRepository implements IFunnelEventsRepository {
  constructor(private readonly db: BetterSQLite3Database) {}

  async insert(row: FunnelEventRecord): Promise<void> {
    this.db.insert(t).values(row).run();
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
        gte(t.createdAt, sinceIso),
        row.profileId !== null ? eq(t.profileId, row.profileId) : isNull(t.profileId),
      ];
      const existing = this.db
        .select({ id: t.id })
        .from(t)
        .where(and(...conds))
        .limit(1)
        .all();
      if (existing.length > 0) return 'deduped';
    }
    this.db.insert(t).values(row).run();
    return 'inserted';
  }

  async summarize(query: FunnelSummaryQuery): Promise<FunnelSummaryRow[]> {
    // COUNT(DISTINCT session_ref) 在 SQLite/PG 都忽略 NULL；NULL 组用 CASE WHEN 单独数。
    const rows = this.db
      .select({
        event: t.event,
        events: sql<number>`count(*)`,
        distinctSessions: sql<number>`count(distinct ${t.sessionRef})`,
        nullSessions: sql<number>`COALESCE(sum(CASE WHEN ${t.sessionRef} IS NULL THEN 1 ELSE 0 END), 0)`,
      })
      .from(t)
      .where(and(...this.filters(query)))
      .groupBy(t.event)
      .orderBy(asc(t.event))
      .all() as RawSummaryRow[];
    return rows.map(toSummaryRow);
  }

  async summarizeDaily(query: FunnelSummaryQuery): Promise<FunnelDailyRow[]> {
    // created_at 是 UTC ISO8601（带 Z 后缀），SQLite date() 按 UTC 归并自然日。
    // select 里必须 .as('day') 才能映射回字段；但 SQLite 方言的 groupBy/orderBy
    // 类型不收 SQL.Aliased（PG 收 SQLWrapper），所以分组/排序用未别名表达式。
    const daySelect = sql<string>`date(${t.createdAt})`.as('day');
    const dayGroup = sql`date(${t.createdAt})`;
    const rows = this.db
      .select({
        day: daySelect,
        event: t.event,
        events: sql<number>`count(*)`,
      })
      .from(t)
      .where(and(...this.filters(query)))
      .groupBy(dayGroup, t.event)
      .orderBy(asc(dayGroup), asc(t.event))
      .all() as RawDailyRow[];
    return rows.map(toDailyRow);
  }

  /** sinceIso 含、untilIso 不含。 */
  private filters(query: FunnelSummaryQuery): SQL[] {
    const f: SQL[] = [gte(t.createdAt, query.sinceIso)];
    if (query.untilIso !== undefined) f.push(lt(t.createdAt, query.untilIso));
    return f;
  }
}
