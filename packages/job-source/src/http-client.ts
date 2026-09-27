import { ProxyAgent, fetch as undiciFetch } from 'undici';
import type { Dispatcher } from 'undici';
import type { JobHttpClient, JobHttpOptions } from './types.js';

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_RETRIES = 2;
const DEFAULT_UA = 'job-agent/0.1 (+https://github.com/bayernjf/job-agent)';
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

const realSleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 生产默认的代理 fetch：undici 的 ProxyAgent 与 undici 自身 fetch 配对，
 * 保证 dispatcher 与 fetch 来自同一 undici 实例（避免与 Node 内置全局 fetch 跨实例 instanceof 校验失败）。
 */
function defaultMakeProxyFetch(proxyUrl: string): typeof fetch {
  const dispatcher: Dispatcher = new ProxyAgent(proxyUrl);
  const proxied = (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) =>
    undiciFetch(input as never, {
      ...(init as Record<string, unknown> | undefined),
      dispatcher,
    } as never);
  return proxied as typeof fetch;
}

export class JobHttpError extends Error {
  constructor(
    public readonly url: string,
    public readonly status: number | undefined,
    message: string,
  ) {
    super(message);
    this.name = 'JobHttpError';
  }
}

/**
 * 岗位源 JSON HTTP 客户端：
 * - AbortController 单请求超时；
 * - 仅对网络错误 / 5xx / 408/425/429 有限重试（指数退避，429 优先读 Retry-After）；
 * - 其余 4xx 立即失败不重试；
 * - fetch 可注入，测试不打真实网络。
 */
export function createJobHttpClient(options: JobHttpOptions = {}): JobHttpClient {
  const proxy = options.proxy?.trim();
  // 显式注入的 fetchImpl 优先；否则配置了非空代理就经代理转发，再否则直连全局 fetch。
  const fetchImpl =
    options.fetchImpl ??
    (proxy ? (options.makeProxyFetch ?? defaultMakeProxyFetch)(proxy) : fetch);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retries = options.retries ?? DEFAULT_RETRIES;
  const userAgent = options.userAgent ?? DEFAULT_UA;
  const sleep = options.sleep ?? realSleep;
  const logger = options.logger;

  // 在途请求的 AbortController 集合：源级预算超时（ingestor withBudget）需要中止所有挂起请求，
  // 否则 Promise.race 放行后底层 socket 仍挂着、Node 进程不退出（runner 上 greenhouse 黑洞即此形态）。
  const activeControllers = new Set<AbortController>();
  // abortAll 置位后 getJson 的 catch 不再重试（预算已超时，重试只会再造挂起请求）。
  let forceStop = false;

  async function getJson<T>(url: string): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      if (forceStop) break;
      const ctrl = new AbortController();
      activeControllers.add(ctrl);
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await fetchImpl(url, {
          signal: ctrl.signal,
          headers: { 'User-Agent': userAgent, Accept: 'application/json' },
        });
        if (res.ok) return (await res.json()) as T;

        const retryAfter = Number(res.headers.get('retry-after') ?? '');
        if (RETRYABLE_STATUS.has(res.status) && attempt < retries) {
          const backoff = Number.isFinite(retryAfter) && retryAfter > 0
            ? retryAfter * 1000
            : 250 * 2 ** attempt;
          logger?.warn(`[http] GET ${url} -> ${res.status}, retry in ${backoff}ms (${attempt + 1}/${retries})`);
          await sleep(backoff);
          continue;
        }
        throw new JobHttpError(url, res.status, `GET ${url} failed with HTTP ${res.status}`);
      } catch (err) {
        lastError = err;
        // 已构造的 JobHttpError（4xx 非重试）直接抛，不再重试
        if (err instanceof JobHttpError) throw err;
        if (forceStop || attempt >= retries) break;
        const backoff = 250 * 2 ** attempt;
        logger?.warn(`[http] GET ${url} network error (${(err as Error).message}), retry in ${backoff}ms`);
        await sleep(backoff);
      } finally {
        clearTimeout(timer);
        activeControllers.delete(ctrl);
      }
    }
    if (lastError instanceof JobHttpError) throw lastError;
    throw new JobHttpError(url, undefined, `GET ${url} failed after ${retries + 1} attempts: ${(lastError as Error).message}`);
  }

  return {
    getJson,
    abortAll() {
      forceStop = true;
      for (const ctrl of activeControllers) ctrl.abort();
      activeControllers.clear();
    },
  };
}
