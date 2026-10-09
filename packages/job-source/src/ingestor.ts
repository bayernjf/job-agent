import type { JobSource } from '@jobagent/shared';
import type { IJobPostingsRepository, NewJobPosting } from '@jobagent/storage';
import { createJobHttpClient } from './http-client.js';
import { makeNormalizedKey } from './normalize/dedupe-key.js';
import type { JobHttpClient, JobHttpOptions, SyncResult, SourceSyncOutcome } from './types.js';
import type { JobSourceAdapter } from './adapters/types.js';

const DEFAULT_STALE_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

/** 单源采集整体预算（毫秒）：ATS 类源在部分网络（如托管 runner）单请求可能挂起超时，
 *  并发拉取只压缩"批数×超时"仍不够时，必须给整个 collect 一个硬顶，超时中止全部在途请求并跳过该源。 */
const DEFAULT_SOURCE_BUDGETS_MS: Record<JobSource, number> = {
  remoteok: 3 * 60_000,
  remotive: 3 * 60_000,
  greenhouse: 8 * 60_000,
  lever: 3 * 60_000,
  hn_whoishiring: 5 * 60_000,
  weworkremotely: 3 * 60_000,
  jobicy: 3 * 60_000,
  websearch: 3 * 60_000, // 指令式搜岗（search-source 执行，不经过 job-source 采集）
  manual: 60_000,
};

export interface SyncOnceDeps {
  adapters: JobSourceAdapter[];
  repo: Pick<IJobPostingsRepository, 'upsertBatch' | 'markStale'>;
  /** 复用/注入 HTTP 客户端；默认按 httpOptions 创建 */
  http?: JobHttpClient;
  httpOptions?: JobHttpOptions;
  now?: () => Date;
  staleDays?: number;
  /** 单源采集预算覆盖（毫秒）；未覆盖的源用 DEFAULT_SOURCE_BUDGETS_MS */
  sourceBudgetsMs?: Partial<Record<JobSource, number>>;
  /** dry-run：只采集校验，不写库、不 markStale */
  dryRun?: boolean;
  logger?: Pick<Console, 'info' | 'warn' | 'error'>;
}

function emptyOutcome(source: SourceSyncOutcome['source'], durationMs: number, error?: string): SourceSyncOutcome {
  return {
    source,
    fetched: 0,
    inserted: 0,
    updated: 0,
    unchanged: 0,
    invalid: 0,
    durationMs,
    ...(error ? { error } : {}),
  };
}

/**
 * 给单个 promise 套整体预算：到点先中止全部在途请求（http.abortAll），再拒绝。
 * Promise.race 放行后挂起的底层请求若不中止，Node 进程会因活跃 socket 永不退出（runner 黑洞即此形态）。
 */
/**
 * Drizzle 的 message 就是整条回显 SQL（一个批次可达上万字符），而真正的数据库错误码在
 * `cause` 里——两者相撞时，日志里只看得到 SQL，看不到原因。有 cause 时只留原因：
 * SQL 由代码可确定、参数是占位符，不额外携带诊断信息。
 */
export function describeIngestionError(err: unknown): string {
  const e = err as (Error & { cause?: Error & { code?: string } }) | undefined;
  const cause = e?.cause;
  if (cause) {
    const code = typeof cause.code === 'string' ? cause.code : 'error';
    return `db ${code}: ${(cause.message ?? '').split('\n')[0] ?? ''}`.slice(0, 240);
  }
  return (e?.message ?? String(err)).split('\n')[0] ?? '';
}

async function withSourceBudget<T>(
  task: Promise<T>,
  budgetMs: number,
  source: JobSource,
  http: JobHttpClient,
  logger: SyncOnceDeps['logger'],
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      http.abortAll();
      reject(new Error(`collect ${source} exceeded ${budgetMs}ms budget; in-flight requests aborted`));
    }, budgetMs);
  });
  try {
    return await Promise.race([task, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 执行一轮岗位采集：源间串行（礼貌抓取），单源失败被捕获并隔离，
 * 不影响其他源；每条岗位已在适配器内过契约校验，这里统一补跨源去重键后批量 upsert。
 * 全部源结束后 markStale（dry-run 除外）。
 */
export async function syncOnce(deps: SyncOnceDeps): Promise<SyncResult> {
  const now = deps.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const http = deps.http ?? createJobHttpClient(deps.httpOptions);
  const staleDays = deps.staleDays ?? DEFAULT_STALE_DAYS;
  const outcomes: SourceSyncOutcome[] = [];
  const budgets: Record<JobSource, number> = {
    ...DEFAULT_SOURCE_BUDGETS_MS,
    ...(deps.sourceBudgetsMs as Partial<Record<JobSource, number>> | undefined),
  } as Record<JobSource, number>;

  for (const adapter of deps.adapters) {
    const t0 = now().getTime();
    try {
      const budgetMs = budgets[adapter.source];
      const collected = await withSourceBudget(
        adapter.collect({ fetchedAt: startedAt, http }),
        budgetMs,
        adapter.source,
        http,
        deps.logger,
      );
      const { postings, invalid } = collected;
      const enriched: NewJobPosting[] = postings.map((p) => ({
        ...p,
        normalizedKey: makeNormalizedKey(p.title, p.company, p.location),
      }));

      let inserted = 0;
      let updated = 0;
      let unchanged = 0;
      if (!deps.dryRun && enriched.length > 0) {
        const counts = await deps.repo.upsertBatch(enriched, startedAt);
        inserted = counts.inserted;
        updated = counts.updated;
        unchanged = counts.unchanged;
      }
      outcomes.push({
        source: adapter.source,
        fetched: postings.length + invalid,
        inserted,
        updated,
        unchanged,
        invalid,
        durationMs: now().getTime() - t0,
      });
      deps.logger?.info(
        `[ingestor] ${adapter.source}: fetched=${postings.length + invalid} valid=${postings.length} ` +
          `inserted=${inserted} updated=${updated} unchanged=${unchanged} invalid=${invalid}` +
          (deps.dryRun ? ' (dry-run)' : ''),
      );
    } catch (err) {
      const message = describeIngestionError(err);
      outcomes.push(emptyOutcome(adapter.source, now().getTime() - t0, message));
      deps.logger?.error?.(`[ingestor] ${adapter.source} failed: ${message}`);
    }
  }

  let markedStale = 0;
  if (!deps.dryRun) {
    const cutoff = new Date(now().getTime() - staleDays * DAY_MS).toISOString();
    markedStale = await deps.repo.markStale(cutoff);
  }

  const ok = outcomes.some((o) => !o.error && o.fetched > 0);
  return { outcomes, ok, startedAt, finishedAt: now().toISOString(), markedStale };
}
