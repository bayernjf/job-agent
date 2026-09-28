import { and, asc, desc, eq, inArray, ilike, or, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { tsGte, tsLt } from './time-text.js';
import {
  jobPostingSignature,
  makeJobPostingId,
  toStoredJobPosting,
  type JobPostingStatus,
  type NewJobPosting,
  type StoredJobPosting,
} from '../entities/index.js';
import type {
  IJobPostingsRepository,
  JobPostingQuery,
  UpsertCounts,
} from '../repositories/job-posting.js';
import { jobPostings as t } from './schema.js';

const UPSERT_BATCH_SIZE = 2500;

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

function clampLimit(n: number | undefined): number {
  if (n === undefined) return DEFAULT_LIMIT;
  if (!Number.isInteger(n) || n < 1) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

function keywordWords(kw: string | undefined): string[] {
  return (kw ?? '')
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length > 0);
}

/** job_postings 仓储的 Postgres 实现（全异步；ILIKE 大小写不敏感）。 */
export class PgJobPostingsRepository implements IJobPostingsRepository {
  constructor(private readonly db: PostgresJsDatabase) {}

  async upsertBatch(postings: NewJobPosting[], now: string): Promise<UpsertCounts> {
    const counts: UpsertCounts = { inserted: 0, updated: 0, unchanged: 0 };
    if (postings.length === 0) return counts;

    // 批量实现（2026-09-27 G2 修复）：原逐条 SELECT+INSERT/UPDATE 在远程 PG（Supabase 东京）
    // 下每行至少 2 次往返，greenhouse 一批 7833 行 ≈ 1.5 万+ 条 SQL 可吃满 20min 同步保险丝。
    // 现改为：1) inArray 批量查已有（1 条）→ 2) 新行分批 INSERT ON CONFLICT DO NOTHING →
    // 3) 既有行分批 upsert，仅值变化时更新（IS DISTINCT FROM 兼容 NULL）→ 4) 未变化行
    // 批量刷新 lastSeenAt/updatedAt（1 条）。总 SQL ≈ 4 + 2×批数。
    // 代价：不再单事务原子；失败会留下部分已写行——upsert 幂等、syncOnce 失败源被隔离，
    // 重跑补齐，符合"部分成功"语义。
    const rows = postings.map((p) => {
      const id = makeJobPostingId(p.source, p.sourceUrl);
      return {
        id,
        jobId: p.jobId,
        source: p.source,
        sourceUrl: p.sourceUrl,
        title: p.title,
        company: p.company,
        location: p.location ?? null,
        remote: p.remote,
        salaryMin: p.salaryMin ?? null,
        salaryMax: p.salaryMax ?? null,
        salaryCurrency: p.salaryCurrency ?? null,
        tags: JSON.stringify(p.tags ?? []),
        description: p.description ?? null,
        postedAt: p.postedAt,
        fetchedAt: p.fetchedAt,
        applyUrl: p.applyUrl ?? null,
        companyLogoUrl: p.companyLogoUrl ?? null,
        companyUrl: p.companyUrl ?? null,
        normalizedKey: p.normalizedKey ?? null,
        status: 'active' as const,
        firstSeenAt: now,
        lastSeenAt: now,
        createdAt: now,
        updatedAt: now,
      };
    });

    // 1) 批量查已有主键
    const existing = await this.db
      .select({ id: t.id })
      .from(t)
      .where(inArray(t.id, rows.map((r) => r.id)));
    const existingIds = new Set(existing.map((e) => e.id));
    const fresh = rows.filter((r) => !existingIds.has(r.id));
    const stale = rows.filter((r) => existingIds.has(r.id));

    // 2) 新行：分批 INSERT（ON CONFLICT DO NOTHING 防并发竞态），RETURNING 计数
    for (const batch of chunk(fresh, UPSERT_BATCH_SIZE)) {
      const inserted = await this.db
        .insert(t)
        .values(batch)
        .onConflictDoNothing()
        .returning({ id: t.id });
      counts.inserted += inserted.length;
    }

    // 3) 既有行：分批 upsert，仅任一可变列变化时更新；值相同的行跳过（第 4 步统一刷新 lastSeenAt）
    const updatedIds = new Set<string>();
    for (const batch of chunk(stale, UPSERT_BATCH_SIZE)) {
      const updated = await this.db
        .insert(t)
        .values(batch)
        .onConflictDoUpdate({
          target: t.id,
          set: {
            jobId: sql`EXCLUDED.job_id`,
            source: sql`EXCLUDED.source`,
            sourceUrl: sql`EXCLUDED.source_url`,
            title: sql`EXCLUDED.title`,
            company: sql`EXCLUDED.company`,
            location: sql`EXCLUDED.location`,
            remote: sql`EXCLUDED.remote`,
            salaryMin: sql`EXCLUDED.salary_min`,
            salaryMax: sql`EXCLUDED.salary_max`,
            salaryCurrency: sql`EXCLUDED.salary_currency`,
            tags: sql`EXCLUDED.tags`,
            description: sql`EXCLUDED.description`,
            postedAt: sql`EXCLUDED.posted_at`,
            fetchedAt: sql`EXCLUDED.fetched_at`,
            applyUrl: sql`EXCLUDED.apply_url`,
            companyLogoUrl: sql`EXCLUDED.company_logo_url`,
            companyUrl: sql`EXCLUDED.company_url`,
            normalizedKey: sql`EXCLUDED.normalized_key`,
            lastSeenAt: now,
            updatedAt: now,
          },
          where: sql`${t.title} IS DISTINCT FROM EXCLUDED.title
            OR ${t.company} IS DISTINCT FROM EXCLUDED.company
            OR ${t.location} IS DISTINCT FROM EXCLUDED.location
            OR ${t.remote} IS DISTINCT FROM EXCLUDED.remote
            OR ${t.salaryMin} IS DISTINCT FROM EXCLUDED.salary_min
            OR ${t.salaryMax} IS DISTINCT FROM EXCLUDED.salary_max
            OR ${t.salaryCurrency} IS DISTINCT FROM EXCLUDED.salary_currency
            OR ${t.tags} IS DISTINCT FROM EXCLUDED.tags
            OR ${t.description} IS DISTINCT FROM EXCLUDED.description
            OR ${t.postedAt} IS DISTINCT FROM EXCLUDED.posted_at
            OR ${t.applyUrl} IS DISTINCT FROM EXCLUDED.apply_url
            OR ${t.companyLogoUrl} IS DISTINCT FROM EXCLUDED.company_logo_url
            OR ${t.companyUrl} IS DISTINCT FROM EXCLUDED.company_url
            OR ${t.normalizedKey} IS DISTINCT FROM EXCLUDED.normalized_key`,
        })
        .returning({ id: t.id });
      for (const r of updated) updatedIds.add(r.id);
      counts.updated += updated.length;
    }

    // 4) 值未变化的行仅刷新 lastSeenAt/updatedAt（保持"本轮又见到"语义），1 条 SQL 批量完成
    const unchangedIds = stale.map((r) => r.id).filter((id) => !updatedIds.has(id));
    if (unchangedIds.length > 0) {
      await this.db
        .update(t)
        .set({ lastSeenAt: now, updatedAt: now })
        .where(inArray(t.id, unchangedIds));
      counts.unchanged = unchangedIds.length;
    }

    return counts;
  }

  async search(query: JobPostingQuery): Promise<StoredJobPosting[]> {
    const conditions = [];
    const status: JobPostingStatus = query.status ?? 'active';
    conditions.push(eq(t.status, status));

    if (query.sources && query.sources.length > 0) {
      conditions.push(inArray(t.source, query.sources));
    }
    if (query.remote !== undefined) {
      conditions.push(eq(t.remote, query.remote));
    }
    if (query.company) {
      conditions.push(eq(t.company, query.company));
    }
    if (query.salaryMinUsd !== undefined) {
      conditions.push(sql`COALESCE(${t.salaryMax}, ${t.salaryMin}) >= ${query.salaryMinUsd}`);
    }
    if (query.postedAfter) {
      conditions.push(tsGte(t.postedAt, query.postedAfter));
    }
    if (query.tags && query.tags.length > 0) {
      const tagMatch = query.tags.map((tag) => ilike(t.tags, `%${tag}%`));
      conditions.push(or(...tagMatch)!);
    }
    for (const word of keywordWords(query.keyword)) {
      conditions.push(
        or(ilike(t.title, `%${word}%`), ilike(t.company, `%${word}%`), ilike(t.tags, `%${word}%`))!,
      );
    }

    const orderBy =
      query.orderBy === 'posted_asc'
        ? asc(t.postedAt)
        : query.orderBy === 'salary_desc'
          ? desc(sql`COALESCE(${t.salaryMax}, ${t.salaryMin})`)
          : desc(t.postedAt);

    const rows = await this.db
      .select()
      .from(t)
      .where(and(...conditions))
      .orderBy(orderBy)
      .limit(clampLimit(query.limit))
      .offset(query.offset ?? 0);
    return rows.map(toStoredJobPosting);
  }

  async countBySource(status: JobPostingStatus = 'active'): Promise<Record<string, number>> {
    const rows = await this.db
      .select({ source: t.source, count: sql<string>`count(*)` })
      .from(t)
      .where(eq(t.status, status))
      .groupBy(t.source);
    const result: Record<string, number> = {};
    for (const row of rows) result[row.source] = Number(row.count);
    return result;
  }

  async countActiveFresh(cutoffIso: string): Promise<Record<string, number>> {
    const rows = await this.db
      .select({ source: t.source, count: sql<string>`count(*)` })
      .from(t)
      .where(and(eq(t.status, 'active'), tsGte(t.lastSeenAt, cutoffIso)))
      .groupBy(t.source);
    const result: Record<string, number> = {};
    for (const row of rows) result[row.source] = Number(row.count);
    return result;
  }

  async markStale(cutoffIso: string): Promise<number> {
    const changed = await this.db
      .update(t)
      .set({ status: 'inactive', updatedAt: new Date().toISOString() })
      .where(and(eq(t.status, 'active'), tsLt(t.lastSeenAt, cutoffIso)))
      .returning({ id: t.id });
    return changed.length;
  }

  async getById(id: string): Promise<StoredJobPosting | undefined> {
    const rows = await this.db.select().from(t).where(eq(t.id, id)).limit(1);
    return rows[0] ? toStoredJobPosting(rows[0]!) : undefined;
  }
}
