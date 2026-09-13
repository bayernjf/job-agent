import type { IJobPostingsRepository, NewJobPosting } from '@jobagent/storage';
import { createJobHttpClient } from './http-client.js';
import { makeNormalizedKey } from './normalize/dedupe-key.js';
import type { JobHttpClient, JobHttpOptions, SyncResult, SourceSyncOutcome } from './types.js';
import type { JobSourceAdapter } from './adapters/types.js';

const DEFAULT_STALE_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface SyncOnceDeps {
  adapters: JobSourceAdapter[];
  repo: Pick<IJobPostingsRepository, 'upsertBatch' | 'markStale'>;
  /** 复用/注入 HTTP 客户端；默认按 httpOptions 创建 */
  http?: JobHttpClient;
  httpOptions?: JobHttpOptions;
  now?: () => Date;
  staleDays?: number;
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

  for (const adapter of deps.adapters) {
    const t0 = now().getTime();
    try {
      const { postings, invalid } = await adapter.collect({ fetchedAt: startedAt, http });
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
      const message = (err as Error).message ?? String(err);
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
