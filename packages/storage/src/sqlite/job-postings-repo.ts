import { and, asc, desc, eq, gte, inArray, like, or, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
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

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

function clampLimit(n: number | undefined): number {
  if (n === undefined) return DEFAULT_LIMIT;
  if (!Number.isInteger(n) || n < 1) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

/** 拆关键词为非空小写词。 */
function keywordWords(kw: string | undefined): string[] {
  return (kw ?? '')
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length > 0);
}

/** job_postings 仓储的 SQLite 实现（异步接口、同步驱动）。 */
export class SqliteJobPostingsRepository implements IJobPostingsRepository {
  constructor(private readonly db: BetterSQLite3Database) {}

  async upsertBatch(postings: NewJobPosting[], now: string): Promise<UpsertCounts> {
    const counts: UpsertCounts = { inserted: 0, updated: 0, unchanged: 0 };

    this.db.transaction((tx) => {
      for (const p of postings) {
        const id = makeJobPostingId(p.source, p.sourceUrl);
        const existing = tx.select().from(t).where(eq(t.id, id)).get();
        const tagsJson = JSON.stringify(p.tags ?? []);
        const base = {
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
          tags: tagsJson,
          description: p.description ?? null,
          postedAt: p.postedAt,
          applyUrl: p.applyUrl ?? null,
          companyLogoUrl: p.companyLogoUrl ?? null,
          companyUrl: p.companyUrl ?? null,
          normalizedKey: p.normalizedKey ?? null,
        };

        if (!existing) {
          tx.insert(t)
            .values({
              ...base,
              id,
              fetchedAt: p.fetchedAt,
              status: 'active',
              firstSeenAt: now,
              lastSeenAt: now,
            })
            .run();
          counts.inserted += 1;
          continue;
        }

        const oldSig = jobPostingSignature(toStoredJobPosting(existing));
        const newSig = jobPostingSignature(p);
        if (oldSig === newSig) {
          // 内容无变化：仅刷新 last_seen，减少写放大
          tx.update(t).set({ lastSeenAt: now, updatedAt: now }).where(eq(t.id, id)).run();
          counts.unchanged += 1;
        } else {
          tx.update(t)
            .set({ ...base, fetchedAt: p.fetchedAt, lastSeenAt: now, updatedAt: now })
            .where(eq(t.id, id))
            .run();
          counts.updated += 1;
        }
      }
    });

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
      conditions.push(
        sql`COALESCE(${t.salaryMax}, ${t.salaryMin}) >= ${query.salaryMinUsd}`,
      );
    }
    if (query.postedAfter) {
      conditions.push(gte(t.postedAt, query.postedAfter));
    }
    if (query.tags && query.tags.length > 0) {
      const tagMatch = query.tags.map((tag) => like(t.tags, `%${tag}%`));
      conditions.push(or(...tagMatch)!);
    }
    for (const word of keywordWords(query.keyword)) {
      conditions.push(
        or(like(t.title, `%${word}%`), like(t.company, `%${word}%`), like(t.tags, `%${word}%`))!,
      );
    }

    const orderBy =
      query.orderBy === 'posted_asc'
        ? asc(t.postedAt)
        : query.orderBy === 'salary_desc'
          ? desc(sql`COALESCE(${t.salaryMax}, ${t.salaryMin})`)
          : desc(t.postedAt);

    const rows = this.db
      .select()
      .from(t)
      .where(and(...conditions))
      .orderBy(orderBy)
      .limit(clampLimit(query.limit))
      .offset(query.offset ?? 0)
      .all();
    return rows.map(toStoredJobPosting);
  }

  async countBySource(status: JobPostingStatus = 'active'): Promise<Record<string, number>> {
    const rows = this.db
      .select({ source: t.source, count: sql<number>`count(*)` })
      .from(t)
      .where(eq(t.status, status))
      .groupBy(t.source)
      .all();
    const result: Record<string, number> = {};
    for (const row of rows) result[row.source] = Number(row.count);
    return result;
  }

  async markStale(cutoffIso: string): Promise<number> {
    const info = this.db
      .update(t)
      .set({ status: 'inactive', updatedAt: new Date().toISOString() })
      .where(and(eq(t.status, 'active'), sql`${t.lastSeenAt} < ${cutoffIso}`))
      .run();
    return Number(info.changes ?? 0);
  }

  async getById(id: string): Promise<StoredJobPosting | undefined> {
    const row = this.db.select().from(t).where(eq(t.id, id)).get();
    return row ? toStoredJobPosting(row) : undefined;
  }
}
