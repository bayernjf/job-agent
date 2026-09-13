import { and, asc, desc, eq, gte, inArray, ilike, or, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
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

    await this.db.transaction(async (tx) => {
      for (const p of postings) {
        const id = makeJobPostingId(p.source, p.sourceUrl);
        const rows = await tx.select().from(t).where(eq(t.id, id)).limit(1);
        const existing = rows[0];
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
          tags: JSON.stringify(p.tags ?? []),
          description: p.description ?? null,
          postedAt: p.postedAt,
          applyUrl: p.applyUrl ?? null,
          companyLogoUrl: p.companyLogoUrl ?? null,
          companyUrl: p.companyUrl ?? null,
          normalizedKey: p.normalizedKey ?? null,
        };

        if (!existing) {
          await tx.insert(t).values({
            ...base,
            id,
            fetchedAt: p.fetchedAt,
            status: 'active',
            firstSeenAt: now,
            lastSeenAt: now,
          });
          counts.inserted += 1;
          continue;
        }

        const oldSig = jobPostingSignature(toStoredJobPosting(existing));
        const newSig = jobPostingSignature(p);
        if (oldSig === newSig) {
          await tx
            .update(t)
            .set({ lastSeenAt: now, updatedAt: now })
            .where(eq(t.id, id));
          counts.unchanged += 1;
        } else {
          await tx
            .update(t)
            .set({ ...base, fetchedAt: p.fetchedAt, lastSeenAt: now, updatedAt: now })
            .where(eq(t.id, id));
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
      conditions.push(sql`COALESCE(${t.salaryMax}, ${t.salaryMin}) >= ${query.salaryMinUsd}`);
    }
    if (query.postedAfter) {
      conditions.push(gte(t.postedAt, query.postedAfter));
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

  async markStale(cutoffIso: string): Promise<number> {
    const changed = await this.db
      .update(t)
      .set({ status: 'inactive', updatedAt: new Date().toISOString() })
      .where(and(eq(t.status, 'active'), sql`${t.lastSeenAt} < ${cutoffIso}`))
      .returning({ id: t.id });
    return changed.length;
  }

  async getById(id: string): Promise<StoredJobPosting | undefined> {
    const rows = await this.db.select().from(t).where(eq(t.id, id)).limit(1);
    return rows[0] ? toStoredJobPosting(rows[0]!) : undefined;
  }
}
