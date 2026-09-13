import type { CollectContext, CollectResult, JobSourceAdapter } from './types.js';
import { buildMany, type RawPostingCandidate } from './builder.js';
import { parseSalaryText } from '../normalize/salary.js';
import { stripHtml } from '../normalize/html.js';
import { toPostedIso } from '../normalize/date.js';

export const REMOTIVE_ENDPOINT = 'https://remotive.com/api/remote-jobs';

export interface RemotiveRawJob {
  id?: number | string;
  url?: string;
  title?: string;
  company_name?: string;
  company_logo?: string;
  company_logo_url?: string;
  category?: string;
  tags?: string[];
  job_type?: string;
  publication_date?: string;
  candidate_required_location?: string;
  salary?: string;
  description?: string;
}

function toCandidate(r: RemotiveRawJob, fetchedAt: string): RawPostingCandidate | undefined {
  if (r.id == null || !r.title) return undefined;

  const salary = parseSalaryText(r.salary);
  const tags = [
    ...(Array.isArray(r.tags) ? r.tags : []),
    ...(r.category ? [r.category] : []),
    ...(r.job_type ? [r.job_type] : []),
  ];

  return {
    jobId: String(r.id),
    source: 'remotive',
    sourceUrl: r.url,
    title: r.title,
    company: r.company_name,
    // candidate_required_location 是「可申请地区」而非办公地；Remotive 整站远程
    location: r.candidate_required_location,
    remote: true,
    salaryMin: salary.min,
    salaryMax: salary.max,
    salaryCurrency: salary.currency,
    tags,
    description: stripHtml(r.description),
    postedAt: toPostedIso(r.publication_date, fetchedAt),
    fetchedAt,
    companyLogoUrl: r.company_logo_url || r.company_logo,
  };
}

/** 纯函数：解析 Remotive `{jobs:[...]}` 响应。 */
export function parseRemotiveJobs(raw: unknown, fetchedAt: string): CollectResult {
  const rows: RemotiveRawJob[] =
    raw && typeof raw === 'object' && Array.isArray((raw as { jobs?: unknown }).jobs)
      ? ((raw as { jobs: RemotiveRawJob[] }).jobs)
      : [];
  return buildMany(rows, (r) => toCandidate(r, fetchedAt));
}

export class RemotiveAdapter implements JobSourceAdapter {
  readonly source = 'remotive' as const;

  async collect(ctx: CollectContext): Promise<CollectResult> {
    const raw = await ctx.http.getJson<unknown>(REMOTIVE_ENDPOINT);
    return parseRemotiveJobs(raw, ctx.fetchedAt);
  }
}
