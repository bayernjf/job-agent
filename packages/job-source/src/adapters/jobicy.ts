import type { CollectContext, CollectResult, JobSourceAdapter } from './types.js';
import { buildMany, type RawPostingCandidate } from './builder.js';
import { stripHtml } from '../normalize/html.js';
import { toPostedIso } from '../normalize/date.js';

export const JOBICY_ENDPOINT = 'https://jobicy.com/api/v2/remote-jobs?count=50';

export interface JobicyRawJob {
  id?: number | string;
  url?: string;
  jobTitle?: string;
  companyName?: string;
  companyLogo?: string;
  companyLogoRec?: string;
  jobType?: string;
  jobExcerpt?: string;
  jobDescription?: string;
  /** 可申请地区，如 ["North America", "Europe"]（地区限制而非办公地） */
  jobGeo?: string[];
  jobLevel?: string;
  jobIndustry?: string[];
  /** 形如 "2026-10-01 12:00:00"（UTC） */
  pubDate?: string;
  annualSalaryMin?: number;
  annualSalaryMax?: number;
  salaryCurrency?: string;
  tags?: string[];
}

function toCandidate(r: JobicyRawJob, fetchedAt: string): RawPostingCandidate | undefined {
  if (r.id == null || !r.jobTitle) return undefined;

  const tags = [
    ...(Array.isArray(r.tags) ? r.tags : []),
    ...(Array.isArray(r.jobIndustry) ? r.jobIndustry : []),
    ...(r.jobType ? [r.jobType] : []),
    ...(r.jobLevel ? [r.jobLevel] : []),
  ];

  return {
    jobId: String(r.id),
    source: 'jobicy',
    sourceUrl: r.url,
    title: r.jobTitle,
    company: r.companyName,
    // jobGeo 是「可申请地区」而非办公地；Jobicy 整站远程
    location: Array.isArray(r.jobGeo) ? r.jobGeo.join(', ') : undefined,
    remote: true,
    salaryMin: r.annualSalaryMin,
    salaryMax: r.annualSalaryMax,
    salaryCurrency: r.salaryCurrency,
    tags,
    description: stripHtml(r.jobDescription ?? r.jobExcerpt),
    postedAt: toPostedIso(r.pubDate, fetchedAt),
    fetchedAt,
    companyLogoUrl: r.companyLogo || r.companyLogoRec,
  };
}

/** 纯函数：解析 Jobicy `{jobs:[...]}` 响应。 */
export function parseJobicyJobs(raw: unknown, fetchedAt: string): CollectResult {
  const rows: JobicyRawJob[] =
    raw && typeof raw === 'object' && Array.isArray((raw as { jobs?: unknown }).jobs)
      ? ((raw as { jobs: JobicyRawJob[] }).jobs)
      : [];
  return buildMany(rows, (r) => toCandidate(r, fetchedAt));
}

export class JobicyAdapter implements JobSourceAdapter {
  readonly source = 'jobicy' as const;

  async collect(ctx: CollectContext): Promise<CollectResult> {
    const raw = await ctx.http.getJson<unknown>(JOBICY_ENDPOINT);
    return parseJobicyJobs(raw, ctx.fetchedAt);
  }
}
