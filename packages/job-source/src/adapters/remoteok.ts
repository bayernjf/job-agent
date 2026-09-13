import type { CollectContext, CollectResult, JobSourceAdapter } from './types.js';
import { buildMany, type RawPostingCandidate } from './builder.js';
import { nullifyZero } from '../normalize/salary.js';
import { stripHtml } from '../normalize/html.js';
import { toPostedIso } from '../normalize/date.js';

export const REMOTEOK_ENDPOINT = 'https://remoteok.com/api';

/** RemoteOK 单条原始岗位（仅声明用到的字段）。 */
export interface RemoteOkRawJob {
  id?: string | number;
  slug?: string;
  epoch?: number;
  date?: string;
  company?: string;
  company_logo?: string;
  logo?: string;
  position?: string;
  tags?: string[];
  description?: string;
  location?: string;
  apply_url?: string;
  url?: string;
  salary_min?: number;
  salary_max?: number;
}

function toCandidate(r: RemoteOkRawJob, fetchedAt: string): RawPostingCandidate | undefined {
  // 数组 [0] 是 {last_updated, legal} meta，没有 id/position，直接跳过
  if (r.id == null || !r.position) return undefined;

  const salaryMin = nullifyZero(r.salary_min);
  const salaryMax = nullifyZero(r.salary_max);
  return {
    jobId: String(r.id),
    source: 'remoteok',
    sourceUrl: r.url || r.apply_url,
    title: r.position,
    company: r.company,
    location: r.location,
    // RemoteOK 整站均为远程岗位
    remote: true,
    salaryMin,
    salaryMax,
    salaryCurrency: salaryMin || salaryMax ? 'USD' : null,
    tags: r.tags,
    description: stripHtml(r.description),
    postedAt: toPostedIso(r.epoch ?? r.date, fetchedAt),
    fetchedAt,
    applyUrl: r.apply_url,
    companyLogoUrl: r.company_logo || r.logo,
  };
}

/** 纯函数：解析 RemoteOK 数组响应（含 meta 头），便于夹具单测。 */
export function parseRemoteOkPosts(raw: unknown, fetchedAt: string): CollectResult {
  const rows = Array.isArray(raw) ? (raw as RemoteOkRawJob[]) : [];
  return buildMany(rows, (r) => toCandidate(r, fetchedAt));
}

export class RemoteOkAdapter implements JobSourceAdapter {
  readonly source = 'remoteok' as const;

  async collect(ctx: CollectContext): Promise<CollectResult> {
    const raw = await ctx.http.getJson<unknown>(REMOTEOK_ENDPOINT);
    return parseRemoteOkPosts(raw, ctx.fetchedAt);
  }
}
