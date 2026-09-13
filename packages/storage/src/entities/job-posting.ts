import { createHash } from 'node:crypto';
import type { JobPosting, JobSource } from '@jobagent/shared';

/**
 * job_postings 实体：职位聚合的领域类型与纯映射（双方言共享）。
 *
 * - 采集侧（packages/job-source）产出 shared 的 `JobPosting`，并附加跨源碰撞键
 *   `normalizedKey`，组成 `NewJobPosting` 交给仓储；
 * - 内部主键 `id` 由 (source, sourceUrl) 稳定派生，保证同源同 URL 幂等；
 * - first/last seen 时间由仓储维护，采集侧不感知。
 */

export type JobPostingStatus = 'active' | 'inactive';
export const JOB_POSTING_STATUSES: readonly JobPostingStatus[] = ['active', 'inactive'];

/** 入库输入：shared 契约 + 跨源归一化碰撞键。 */
export type NewJobPosting = JobPosting & { normalizedKey: string };

/** 存储行（camelCase，tags 已解析为数组）。 */
export interface StoredJobPosting extends NewJobPosting {
  id: string;
  status: JobPostingStatus;
  firstSeenAt: string;
  lastSeenAt: string;
  createdAt: string;
  updatedAt: string;
}

/** Drizzle 查询返回的原始行（camelCase JS key；tags 为 JSON 文本），两方言结构一致。 */
export interface RawJobPostingRow {
  id: string;
  jobId: string;
  source: string;
  sourceUrl: string;
  title: string;
  company: string;
  location: string | null;
  remote: boolean;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
  tags: string;
  description: string | null;
  postedAt: string;
  fetchedAt: string;
  applyUrl: string | null;
  companyLogoUrl: string | null;
  companyUrl: string | null;
  normalizedKey: string | null;
  status: string;
  firstSeenAt: string;
  lastSeenAt: string;
  createdAt: string;
  updatedAt: string;
}

/** 由 (source, sourceUrl) 派生稳定内部主键（同源同 URL 多次入库得到同一 id）。 */
export function makeJobPostingId(source: string, sourceUrl: string): string {
  return createHash('sha1').update(`${source}\u0000${sourceUrl}`).digest('hex').slice(0, 16);
}

/**
 * 可变内容签名：用于 upsert 时区分 updated 与 unchanged（只刷 last_seen 不算内容更新）。
 * 不含 first/last seen、fetched、status、id 等由仓储维护的字段。字段顺序固定。
 */
export function jobPostingSignature(
  p: Pick<
    NewJobPosting,
    | 'jobId'
    | 'title'
    | 'company'
    | 'location'
    | 'remote'
    | 'salaryMin'
    | 'salaryMax'
    | 'salaryCurrency'
    | 'tags'
    | 'description'
    | 'postedAt'
    | 'applyUrl'
    | 'companyLogoUrl'
    | 'companyUrl'
    | 'normalizedKey'
  >,
): string {
  return JSON.stringify([
    p.jobId,
    p.title,
    p.company,
    p.location ?? null,
    p.remote,
    p.salaryMin ?? null,
    p.salaryMax ?? null,
    p.salaryCurrency ?? null,
    [...p.tags].sort(),
    p.description ?? null,
    p.postedAt,
    p.applyUrl ?? null,
    p.companyLogoUrl ?? null,
    p.companyUrl ?? null,
    p.normalizedKey,
  ]);
}

function parseTags(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === 'string') : [];
  } catch {
    return [];
  }
}

function toStatus(raw: string): JobPostingStatus {
  return raw === 'inactive' ? 'inactive' : 'active';
}

/** Drizzle 行 → 领域对象（纯函数，双方言共用）。 */
export function toStoredJobPosting(row: RawJobPostingRow): StoredJobPosting {
  return {
    id: row.id,
    jobId: row.jobId,
    source: row.source as JobSource,
    sourceUrl: row.sourceUrl,
    title: row.title,
    company: row.company,
    location: row.location,
    remote: row.remote,
    salaryMin: row.salaryMin,
    salaryMax: row.salaryMax,
    salaryCurrency: row.salaryCurrency,
    tags: parseTags(row.tags),
    description: row.description,
    postedAt: row.postedAt,
    fetchedAt: row.fetchedAt,
    applyUrl: row.applyUrl ?? undefined,
    companyLogoUrl: row.companyLogoUrl ?? undefined,
    companyUrl: row.companyUrl ?? undefined,
    normalizedKey: row.normalizedKey ?? '',
    status: toStatus(row.status),
    firstSeenAt: row.firstSeenAt,
    lastSeenAt: row.lastSeenAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
