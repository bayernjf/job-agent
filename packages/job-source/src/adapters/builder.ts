import { JobPostingSchema, type JobPosting, type JobSource } from '@jobagent/shared';
import { canonicalizeUrl } from '../normalize/dedupe-key.js';
import type { CollectResult } from './types.js';

/** 适配器映射后的宽松候选：字段可能含空串/错误类型，统一在此清洗与校验。 */
export interface RawPostingCandidate {
  jobId: unknown;
  source: JobSource;
  sourceUrl: unknown;
  title: unknown;
  company: unknown;
  location?: unknown;
  remote?: unknown;
  salaryMin?: unknown;
  salaryMax?: unknown;
  salaryCurrency?: unknown;
  tags?: unknown;
  description?: unknown;
  postedAt?: unknown;
  fetchedAt: string;
  applyUrl?: unknown;
  companyLogoUrl?: unknown;
  companyUrl?: unknown;
}

export type BuildResult =
  | { ok: true; posting: JobPosting }
  | { ok: false; reason: string };

function cleanText(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t.length > 0 ? t : undefined;
}

/** location 为 nullish 字段：空串归一为 null。 */
function cleanNullableText(v: unknown): string | null {
  return cleanText(v) ?? null;
}

function cleanUrl(v: unknown): string | undefined {
  const t = cleanText(v);
  if (!t) return undefined;
  try {
    // canonicalizeUrl 内部用 new URL 校验；非法 URL 会原样返回，这里再校验一次
    const canon = canonicalizeUrl(t);
    new URL(canon);
    return canon;
  } catch {
    return undefined;
  }
}

function cleanTags(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((x) => (typeof x === 'string' ? x.trim() : ''))
    .filter((x) => x.length > 0);
}

function cleanNumber(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** 清洗候选并过 JobPostingSchema（Zod）；失败返回原因，不抛异常。 */
export function buildPosting(raw: RawPostingCandidate): BuildResult {
  const sourceUrl = cleanUrl(raw.sourceUrl);
  const candidate = {
    jobId: cleanText(raw.jobId) ?? '',
    source: raw.source,
    sourceUrl: sourceUrl ?? '',
    title: cleanText(raw.title) ?? '',
    company: cleanText(raw.company) ?? '',
    location: cleanNullableText(raw.location),
    remote: typeof raw.remote === 'boolean' ? raw.remote : false,
    salaryMin: cleanNumber(raw.salaryMin),
    salaryMax: cleanNumber(raw.salaryMax),
    salaryCurrency: cleanText(raw.salaryCurrency) ?? null,
    tags: cleanTags(raw.tags),
    description: cleanNullableText(raw.description),
    postedAt: cleanText(raw.postedAt) ?? raw.fetchedAt,
    fetchedAt: raw.fetchedAt,
    applyUrl: cleanUrl(raw.applyUrl),
    companyLogoUrl: cleanUrl(raw.companyLogoUrl),
    companyUrl: cleanUrl(raw.companyUrl),
  };

  const parsed = JobPostingSchema.safeParse(candidate);
  if (parsed.success) return { ok: true, posting: parsed.data };
  return { ok: false, reason: parsed.error.issues.map((i) => `${i.path.join('.')}:${i.message}`).join('; ') };
}

/**
 * 遍历源原始行：map 返回 undefined 表示「非岗位，跳过且不计 invalid」（如 RemoteOK 的 meta 头）；
 * 返回候选则清洗校验，校验失败计 invalid 但不中断。
 */
export function buildMany<T>(
  rows: T[] | null | undefined,
  map: (row: T) => RawPostingCandidate | undefined,
  onInvalid?: (row: T, reason: string) => void,
): CollectResult {
  const postings: JobPosting[] = [];
  let invalid = 0;
  for (const row of rows ?? []) {
    const candidate = map(row);
    if (!candidate) continue;
    const result = buildPosting(candidate);
    if (result.ok) postings.push(result.posting);
    else {
      invalid += 1;
      onInvalid?.(row, result.reason);
    }
  }
  return { postings, invalid };
}
