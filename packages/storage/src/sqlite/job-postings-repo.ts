import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, gte, inArray, isNull, like, or, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import {
  dedupePostingsById,
  jobPostingSignature,
  makeJobPostingId,
  toStoredJobPosting,
  RECRUITER_POSTING_SOURCE,
  type JobPostingStatus,
  type NewJobPosting,
  type RecruiterPostingDraft,
  type StoredJobPosting,
} from '../entities/index.js';
import type {
  IJobPostingsRepository,
  JobPostingQuery,
  UpsertCounts,
} from '../repositories/job-posting.js';
import { jobPostings as t } from './schema.js';

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 5000;

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
    // 与 PG 批量实现对齐：组批前按派生主键去重（保留最后一次出现），
    // 同批重复岗位只计一次，且计数口径双方言一致。
    const unique = dedupePostingsById(postings);

    this.db.transaction((tx) => {
      for (const p of unique) {
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
          searchRunId: p.searchRunId ?? null,
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
    // 公开池判据（决策 #25，B3-a）：招聘方自建 JD 只有在被显式点名 ownerAccountId 时
    // 才返回；默认 IS NULL 是安全侧——忘记加条件的调用方只会少看私有行，不会泄露。
    conditions.push(
      query.ownerAccountId
        ? eq(t.createdByAccountId, query.ownerAccountId)
        : isNull(t.createdByAccountId),
    );

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
    if (query.seenAfter) {
      conditions.push(gte(t.lastSeenAt, query.seenAfter));
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
      .where(and(eq(t.status, status), isNull(t.createdByAccountId)))
      .groupBy(t.source)
      .all();
    const result: Record<string, number> = {};
    for (const row of rows) result[row.source] = Number(row.count);
    return result;
  }

  async countActiveFresh(cutoffIso: string): Promise<Record<string, number>> {
    const rows = this.db
      .select({ source: t.source, count: sql<number>`count(*)` })
      .from(t)
      .where(
        and(eq(t.status, 'active'), gte(t.lastSeenAt, cutoffIso), isNull(t.createdByAccountId)),
      )
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
      .where(
        and(
          eq(t.status, 'active'),
          sql`${t.lastSeenAt} < ${cutoffIso}`,
          // 自建 JD 由招聘方自己下线，不参与采集侧的失活清扫（它永不被重新见到）
          isNull(t.createdByAccountId),
        ),
      )
      .run();
    return Number(info.changes ?? 0);
  }

  async insertOwned(draft: RecruiterPostingDraft, now: string): Promise<StoredJobPosting> {
    const jobId = randomUUID();
    // `*.invalid` 是 RFC 2606 保留域，永远解析不了：它既满足 sourceUrl 的 URL 形态
    // （读取侧会用 JobPostingSchema 再校验一次），又保证没人把这个私有岗位当外链去抓。
    const sourceUrl = `https://recruiter.invalid/${draft.createdByAccountId}/${jobId}`;
    const id = makeJobPostingId(RECRUITER_POSTING_SOURCE, sourceUrl);
    this.db
      .insert(t)
      .values({
        id,
        jobId,
        source: RECRUITER_POSTING_SOURCE,
        sourceUrl,
        title: draft.title,
        company: draft.company,
        location: draft.location ?? null,
        remote: draft.remote,
        salaryMin: draft.salaryMin ?? null,
        salaryMax: draft.salaryMax ?? null,
        salaryCurrency: draft.salaryCurrency ?? null,
        tags: JSON.stringify(draft.tags ?? []),
        description: draft.description ?? null,
        postedAt: draft.postedAt,
        fetchedAt: draft.fetchedAt,
        applyUrl: draft.applyUrl ?? null,
        companyLogoUrl: draft.companyLogoUrl ?? null,
        companyUrl: draft.companyUrl ?? null,
        normalizedKey: null,
        searchRunId: null,
        status: 'active',
        createdByAccountId: draft.createdByAccountId,
        firstSeenAt: now,
        lastSeenAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    const row = this.db.select().from(t).where(eq(t.id, id)).get();
    if (!row) throw new Error(`job posting ${id} vanished right after insert`);
    return toStoredJobPosting(row);
  }

  async listOwned(
    accountId: string,
    opts: { status?: JobPostingStatus; limit?: number; offset?: number } = {},
  ): Promise<StoredJobPosting[]> {
    const conditions = [eq(t.createdByAccountId, accountId)];
    if (opts.status) conditions.push(eq(t.status, opts.status));
    const rows = this.db
      .select()
      .from(t)
      .where(and(...conditions))
      .orderBy(desc(t.postedAt))
      .limit(clampLimit(opts.limit))
      .offset(opts.offset ?? 0)
      .all();
    return rows.map(toStoredJobPosting);
  }

  async retireOwned(
    id: string,
    accountId: string,
    now: string,
  ): Promise<StoredJobPosting | undefined> {
    // 行级归属：非本人一律当不存在（调用方回 404，不泄露该 id 归谁）。
    const owned = this.db
      .select()
      .from(t)
      .where(and(eq(t.id, id), eq(t.createdByAccountId, accountId)))
      .get();
    if (!owned) return undefined;
    this.db
      .update(t)
      .set({ status: 'inactive', updatedAt: now })
      .where(eq(t.id, id))
      .run();
    return { ...toStoredJobPosting(owned), status: 'inactive', updatedAt: now };
  }

  async listBySearchRun(runId: string, limit = 200): Promise<StoredJobPosting[]> {
    const rows = this.db
      .select()
      .from(t)
      .where(eq(t.searchRunId, runId))
      .orderBy(desc(t.firstSeenAt))
      .limit(limit)
      .all();
    return rows.map(toStoredJobPosting);
  }

  async getById(id: string): Promise<StoredJobPosting | undefined> {
    const row = this.db.select().from(t).where(eq(t.id, id)).get();
    return row ? toStoredJobPosting(row) : undefined;
  }
}
