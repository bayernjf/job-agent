import type { JobSource, JobPosting } from '@jobagent/shared';
import type { CollectContext, CollectResult, JobSourceAdapter } from './types.js';
import { buildMany, type RawPostingCandidate } from './builder.js';
import { stripHtml, truncateText } from '../normalize/html.js';
import { epochToIso } from '../normalize/date.js';
import { inferRemote, workplaceTypeToRemote } from '../normalize/remote.js';

const POSTINGS_ENDPOINT = (slug: string) =>
  `https://api.lever.co/v0/postings/${encodeURIComponent(slug)}?mode=json`;
const DEFAULT_INTERVAL_MS = 300;
const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface LeverBoard {
  /** Lever posting site slug（URL jobs.lever.co/{slug}） */
  slug: string;
  /** Lever 单条 posting 不含公司名，由 board 提供 */
  companyName: string;
}

export interface LeverRawPosting {
  id?: string;
  text?: string;
  hostedUrl?: string;
  applyUrl?: string;
  createdAt?: number;
  workplaceType?: string;
  country?: string;
  categories?: {
    commitment?: string;
    location?: string;
    team?: string;
    allLocations?: string[];
  } | null;
  description?: string;
  descriptionPlain?: string;
  descriptionBody?: string;
  descriptionBodyPlain?: string;
  lists?: Array<{ text?: string; content?: string }> | null;
}

/** 正文优先级：纯文本 > HTML 剥离 > lists 拼接。 */
function pickDescription(r: LeverRawPosting): string | null {
  const plain = truncateText(r.descriptionPlain) ?? truncateText(r.descriptionBodyPlain);
  if (plain) return plain;
  const html = stripHtml(r.description) ?? stripHtml(r.descriptionBody);
  if (html) return html;
  if (Array.isArray(r.lists) && r.lists.length > 0) {
    const sections = r.lists
      .map((l) => [l.text, stripHtml(l.content)].filter((x) => x && x.length > 0).join('\n'))
      .filter((s) => s.length > 0);
    return truncateText(sections.join('\n\n'));
  }
  return null;
}

function toCandidate(r: LeverRawPosting, fetchedAt: string, companyName: string): RawPostingCandidate | undefined {
  if (!r.id || !r.text) return undefined;

  const cats = r.categories ?? {};
  const location = cats.location ?? (cats.allLocations ?? []).join('; ');
  const tags = [cats.team, cats.commitment, r.workplaceType].filter(
    (x): x is string => typeof x === 'string' && x.length > 0,
  );
  const explicitRemote = workplaceTypeToRemote(r.workplaceType);
  const postedAt = epochToIso(r.createdAt) ?? fetchedAt;

  return {
    jobId: r.id,
    source: 'lever',
    sourceUrl: r.hostedUrl,
    title: r.text,
    company: companyName,
    location: location || undefined,
    remote: inferRemote(explicitRemote, location, r.workplaceType),
    salaryMin: null,
    salaryMax: null,
    salaryCurrency: null,
    tags,
    description: pickDescription(r),
    postedAt,
    fetchedAt,
    applyUrl: r.applyUrl,
  };
}

/** 纯函数：解析单个 board 的 Lever posting 数组。 */
export function parseLeverPostings(raw: unknown, fetchedAt: string, companyName: string): CollectResult {
  const rows = Array.isArray(raw) ? (raw as LeverRawPosting[]) : [];
  return buildMany(rows, (r) => toCandidate(r, fetchedAt, companyName));
}

export interface LeverAdapterOptions {
  boards: LeverBoard[];
  sleep?: (ms: number) => Promise<void>;
  intervalMs?: number;
  /** 单个 board 失败时记录警告，不影响其他 board */
  logger?: Pick<Console, 'warn'>;
}

export class LeverAdapter implements JobSourceAdapter {
  readonly source: JobSource = 'lever';
  private readonly boards: LeverBoard[];
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly intervalMs: number;
  private readonly logger?: Pick<Console, 'warn'>;

  constructor(options: LeverAdapterOptions) {
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
        const raw = await ctx.http.getJson<unknown>(POSTINGS_ENDPOINT(board.slug));
        const part = parseLeverPostings(raw, ctx.fetchedAt, board.companyName);
        merged.push(...part.postings);
        invalid += part.invalid;
      } catch (err) {
        this.logger?.warn(`[lever] board "${board.slug}" skipped: ${(err as Error).message}`);
      }
      if (i < this.boards.length - 1) await this.sleep(this.intervalMs);
    }
    return { postings: merged, invalid };
  }
}
