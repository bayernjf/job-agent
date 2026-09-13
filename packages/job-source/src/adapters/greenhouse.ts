import type { JobSource, JobPosting } from '@jobagent/shared';
import type { CollectContext, CollectResult, JobSourceAdapter } from './types.js';
import { buildMany, type RawPostingCandidate } from './builder.js';
import { parseSalaryText, type SalaryRange } from '../normalize/salary.js';
import { stripHtml } from '../normalize/html.js';
import { toPostedIso } from '../normalize/date.js';
import { inferRemote } from '../normalize/remote.js';

const BOARD_ENDPOINT = (token: string) =>
  `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(token)}/jobs?content=true`;
const DEFAULT_INTERVAL_MS = 300;
const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface GreenhouseBoard {
  token: string;
  /** company_name 缺失时的回退公司名（一般等于 board 公司） */
  companyName?: string;
}

export interface GreenhouseRawJob {
  id?: number | string;
  title?: string;
  company_name?: string;
  absolute_url?: string;
  first_published?: string;
  updated_at?: string;
  location?: { name?: string } | null;
  content?: string;
  metadata?: Array<{ name?: string; value?: unknown }> | null;
  departments?: Array<{ name?: string }> | null;
  offices?: Array<{ name?: string }> | null;
}

/** Greenhouse 薪资藏在 metadata（常为 null）；尽力解析名为 compensation/salary 的值。 */
function extractSalary(metadata: GreenhouseRawJob['metadata']): SalaryRange {
  if (!Array.isArray(metadata)) return { min: null, max: null, currency: null };
  const hit = metadata.find((m) => /salary|compensation|pay/i.test(m?.name ?? ''));
  if (!hit) return { min: null, max: null, currency: null };
  return parseSalaryText(typeof hit.value === 'string' ? hit.value : String(hit.value ?? ''));
}

function toCandidate(r: GreenhouseRawJob, fetchedAt: string, fallbackCompany?: string): RawPostingCandidate | undefined {
  if (r.id == null || !r.title) return undefined;

  const location = r.location?.name;
  const deptTags = [
    ...(r.departments ?? []).map((d) => d?.name ?? ''),
    ...(r.offices ?? []).map((o) => o?.name ?? ''),
  ].filter((s) => s.length > 0);
  const salary = extractSalary(r.metadata);
  const company = r.company_name || fallbackCompany;

  return {
    jobId: String(r.id),
    source: 'greenhouse',
    sourceUrl: r.absolute_url,
    title: r.title,
    company,
    location,
    remote: inferRemote(undefined, location, deptTags.join(' ')),
    salaryMin: salary.min,
    salaryMax: salary.max,
    salaryCurrency: salary.currency,
    tags: deptTags,
    description: stripHtml(r.content), // 双重实体转义由 stripHtml 处理
    postedAt: toPostedIso(r.first_published ?? r.updated_at, fetchedAt),
    fetchedAt,
  };
}

/** 纯函数：解析单个 board 的 `{jobs:[...]}`，company_name 缺失时用 fallback。 */
export function parseGreenhouseJobs(
  raw: unknown,
  fetchedAt: string,
  fallbackCompany?: string,
): CollectResult {
  const rows: GreenhouseRawJob[] =
    raw && typeof raw === 'object' && Array.isArray((raw as { jobs?: unknown }).jobs)
      ? ((raw as { jobs: GreenhouseRawJob[] }).jobs)
      : [];
  return buildMany(rows, (r) => toCandidate(r, fetchedAt, fallbackCompany));
}

export interface GreenhouseAdapterOptions {
  boards: GreenhouseBoard[];
  sleep?: (ms: number) => Promise<void>;
  intervalMs?: number;
  /** 单个 board 失败时记录警告，不影响其他 board */
  logger?: Pick<Console, 'warn'>;
}

export class GreenhouseAdapter implements JobSourceAdapter {
  readonly source: JobSource = 'greenhouse';
  private readonly boards: GreenhouseBoard[];
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly intervalMs: number;
  private readonly logger?: Pick<Console, 'warn'>;

  constructor(options: GreenhouseAdapterOptions) {
    this.boards = options.boards;
    this.sleep = options.sleep ?? realSleep;
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.logger = options.logger;
  }

  async collect(ctx: CollectContext): Promise<CollectResult> {
    const merged: JobPosting[] = [];
    let invalid = 0;
    for (let i = 0; i < this.boards.length; i += 1) {
      const board = this.boards[i]!;
      try {
        const raw = await ctx.http.getJson<unknown>(BOARD_ENDPOINT(board.token));
        const part = parseGreenhouseJobs(raw, ctx.fetchedAt, board.companyName ?? board.token);
        merged.push(...part.postings);
        invalid += part.invalid;
      } catch (err) {
        this.logger?.warn(`[greenhouse] board "${board.token}" skipped: ${(err as Error).message}`);
      }
      if (i < this.boards.length - 1) await this.sleep(this.intervalMs); // 礼貌限速
    }
    return { postings: merged, invalid };
  }
}
