import type { JobSource } from '@jobagent/shared';

/** 岗位源 HTTP 客户端的最小抽象（测试注入 fake，生产用 createJobHttpClient）。 */
export interface JobHttpClient {
  getJson<T>(url: string): Promise<T>;
}

export interface JobHttpOptions {
  /** 自定义 fetch（测试注入；默认 Node 全局 fetch） */
  fetchImpl?: typeof fetch;
  /** 单请求超时毫秒，默认 15000 */
  timeoutMs?: number;
  /** 网络错误 / 5xx / 429 重试次数（4xx 不重试），默认 2 */
  retries?: number;
  userAgent?: string;
  /** 退避等待注入（测试用），默认真实 setTimeout */
  sleep?: (ms: number) => Promise<void>;
  logger?: Pick<Console, 'warn' | 'error'>;
}

/** 单个数据源一次同步的结果汇总。 */
export interface SourceSyncOutcome {
  source: JobSource;
  /** parse 出的条数（含后续校验未过的） */
  fetched: number;
  inserted: number;
  updated: number;
  unchanged: number;
  /** Zod 校验未通过条数 */
  invalid: number;
  /** 单源失败信息；存在即该源失败，但不影响其他源 */
  error?: string;
  durationMs: number;
}

export interface SyncResult {
  outcomes: SourceSyncOutcome[];
  /** 至少一个源无错误且有产出 */
  ok: boolean;
  startedAt: string;
  finishedAt: string;
  /** markStale 置为 inactive 的条数 */
  markedStale: number;
}
