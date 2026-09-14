/**
 * Gitee v5 REST client：原生 fetch（可注入）+ 单画像请求预算 + x-total 分页
 * + 弱 ETag 条件请求 + 429/5xx 有限退避。无 GraphQL、无 Octokit 依赖。
 */

/** 采集错误：not_found（账号/仓库不存在）/ api_error（Gitee 侧失败）/ budget_exhausted */
export class GiteeSourceError extends Error {
  constructor(
    readonly code: 'not_found' | 'api_error' | 'budget_exhausted',
    message: string,
  ) {
    super(message);
    this.name = 'GiteeSourceError';
  }
}

const DEFAULT_BASE_URL = 'https://gitee.com/api/v5';

interface ClientOptions {
  baseUrl?: string;
  token?: string;
  fetchImpl: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  budgetLimit: number;
  log: Pick<Console, 'info' | 'warn' | 'error'>;
  maxRetries?: number;
}

interface CacheEntry {
  etag: string;
  body: unknown;
}

export interface ListPageOptions {
  perPage: number;
  maxPages: number;
  /** 额外 query 参数（如 sort=state） */
  params?: Record<string, string | number>;
}

export class GiteeClient {
  private readonly baseUrl: string;
  private readonly cache = new Map<string, CacheEntry>();
  private calls = 0;

  constructor(private readonly opts: ClientOptions) {
    this.baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
  }

  get restCalls(): number {
    return this.calls;
  }

  /** 单页 GET：预算记账、弱 ETag、429/5xx 退避重试、错误归一 */
  private async getPage<T>(
    path: string,
    query: Record<string, string | number>,
  ): Promise<{ data: T; total: number | null }> {
    if (this.calls >= this.opts.budgetLimit) {
      throw new GiteeSourceError('budget_exhausted', 'per-profile REST budget exhausted before request');
    }

    const url = this.buildUrl(path, query);
    const cacheKey = url;
    const maxRetries = this.opts.maxRetries ?? 2;
    let lastErr: Error | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const cached = this.cache.get(cacheKey);
      const headers: Record<string, string> = { Accept: 'application/json' };
      if (this.opts.token) headers.Authorization = `token ${this.opts.token}`;
      if (cached) headers['If-None-Match'] = cached.etag;

      this.calls += 1;
      let res: Response;
      try {
        res = await this.opts.fetchImpl(url, { method: 'GET', headers });
      } catch (err) {
        // 网络层错误：可重试
        lastErr = err as Error;
        if (attempt < maxRetries) {
          await this.backoff(attempt);
          continue;
        }
        throw new GiteeSourceError('api_error', `network error on ${path}: ${lastErr.message}`);
      }

      // 弱 ETag 命中：复用缓存正文，不再消耗解析
      if (res.status === 304 && cached) {
        return { data: cached.body as T, total: null };
      }
      if (res.status === 404) {
        throw new GiteeSourceError('not_found', `Gitee resource not found: ${path}`);
      }
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`HTTP ${res.status}`);
        if (attempt < maxRetries) {
          const retryAfter = Number(res.headers.get('retry-after'));
          await this.backoff(attempt, Number.isFinite(retryAfter) ? retryAfter * 1000 : undefined);
          continue;
        }
        throw new GiteeSourceError('api_error', `Gitee ${path} failed after retries: HTTP ${res.status}`);
      }
      if (!res.ok) {
        throw new GiteeSourceError('api_error', `Gitee ${path} failed: HTTP ${res.status}`);
      }

      const data = (await res.json()) as T;
      const etag = res.headers.get('etag');
      if (etag) this.cache.set(cacheKey, { etag, body: data });
      const totalHeader = res.headers.get('x-total');
      const total = totalHeader != null && Number.isFinite(Number(totalHeader)) ? Number(totalHeader) : null;
      return { data, total };
    }

    throw new GiteeSourceError('api_error', `Gitee ${path} failed: ${lastErr?.message ?? 'unknown'}`);
  }

  /**
   * 自动翻页：从第 1 页起，直到「不足一页」（Gitee 无 Link 头的兜底终止）
   * 或取满 x-total，或达到 maxPages 安全上限。
   */
  async listAll<T>(path: string, pageOpts: ListPageOptions): Promise<T[]> {
    const out: T[] = [];
    for (let page = 1; page <= pageOpts.maxPages; page += 1) {
      const { data, total } = await this.getPage<T[]>(path, {
        page,
        per_page: pageOpts.perPage,
        ...(pageOpts.params ?? {}),
      });
      const rows = Array.isArray(data) ? data : [];
      out.push(...rows);
      if (rows.length < pageOpts.perPage) break; // 末页兜底
      if (total != null && out.length >= total) break; // x-total 已取满
    }
    return out;
  }

  /** 单资源 GET（不分页） */
  async get<T>(path: string, params?: Record<string, string | number>): Promise<T> {
    const { data } = await this.getPage<T>(path, params ?? {});
    return data;
  }

  private buildUrl(path: string, query: Record<string, string | number>): string {
    const usp = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) usp.set(k, String(v));
    const qs = usp.toString();
    return `${this.baseUrl}${path}${qs ? `?${qs}` : ''}`;
  }

  private async backoff(attempt: number, explicitMs?: number): Promise<void> {
    const base = explicitMs ?? 200 * 2 ** attempt;
    this.opts.log.warn?.(`[gitee-source] retry after ${base}ms (attempt ${attempt + 1})`);
    await this.opts.sleep(base);
  }
}
