/**
 * Tavily Search 客户端（指令式搜岗主通道，决策已拍板 2026-10-08）。
 *
 * API 形状（官方文档 2026-10 核实）：
 * - POST https://api.tavily.com/search，Authorization: Bearer <key>
 *   body { query, search_depth: 'basic'|'fast'|'advanced', max_results: 1-20, ... }
 *   响应 { query, results: [{ title, url, content, score, published_date?, ... }], usage: { credits } }
 * - basic/fast 每请求 1 credit；advanced 2 credits。P0 默认 basic。
 */
import type { SearchClient, SearchResultItem } from './types.js';

export interface TavilySearchOptions {
  /** 服务端 env TAVILY_API_KEY（凭证只经此注入，绝不入库/入 Git） */
  apiKey: string;
  baseUrl?: string;
  /** 测试注入自定义 fetch（默认 Node 全局 fetch） */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** 搜索深度：basic（默认，1 credit）/ fast / advanced（2 credits） */
  searchDepth?: 'basic' | 'fast' | 'advanced';
}

interface TavilySearchResponse {
  query?: string;
  results?: Array<{
    title?: string;
    url?: string;
    content?: string;
    score?: number;
    published_date?: string | null;
  }>;
  usage?: { credits?: number };
}

export class TavilySearchClient implements SearchClient {
  readonly provider = 'tavily';
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly searchDepth: NonNullable<TavilySearchOptions['searchDepth']>;

  constructor(private readonly opts: TavilySearchOptions) {
    this.baseUrl = opts.baseUrl ?? 'https://api.tavily.com';
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.searchDepth = opts.searchDepth ?? 'basic';
  }

  async search(query: string, opts?: { maxResults?: number }): Promise<SearchResultItem[]> {
    const maxResults = Math.min(Math.max(opts?.maxResults ?? 5, 1), 10);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/search`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.opts.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          query,
          search_depth: this.searchDepth,
          max_results: maxResults,
          include_answer: false,
          include_raw_content: false,
        }),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      throw new TavilyError(`tavily search failed (${(err as Error).message})`, err);
    }
    clearTimeout(timer);

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new TavilyError(`tavily search HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    const data = (await res.json()) as TavilySearchResponse;
    const items = (data.results ?? [])
      .filter((r) => typeof r.url === 'string' && r.url.length > 0 && typeof r.title === 'string')
      .map((r) => ({
        title: r.title as string,
        url: r.url as string,
        content: typeof r.content === 'string' ? r.content : '',
        score: typeof r.score === 'number' ? r.score : 0,
        publishedDate: r.published_date ?? null,
      }));
    return items;
  }
}

export class TavilyError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'TavilyError';
  }
}
