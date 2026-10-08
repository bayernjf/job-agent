/**
 * 搜岗执行（design-websearch-job-discovery §2 数据流 ③→⑤）。
 *
 * 确定性执行链：claimNextQueued（原子认领）→ 对 conditions.queries 逐条搜索 →
 * URL 去重 → 启发式抽取（JD 抽取纯函数）→ buildPosting 校验 → upsertBatch 入库 →
 * finish 回写（done / partial / failed，显式原因）。
 *
 * 成本闸：maxQueries（默认 3）与 maxResultsPerQuery（默认 5）由调用方按账号预算
 * 传入，防单次搜岗烧太多 credits（设计 §8）。
 */
import { createHash } from 'node:crypto';
import {
  buildPosting,
  canonicalizeUrl,
  makeNormalizedKey,
  type RawPostingCandidate,
} from '@jobagent/job-source';
import type { JobPosting } from '@jobagent/shared';
import type {
  IJobPostingsRepository,
  ISearchRunsRepository,
  StoredSearchRun,
} from '@jobagent/storage';
import { extractJobFromSearchResult } from './jd-extract.js';
import type { SearchClient } from './types.js';

export interface RunSearchDeps {
  searchRuns: ISearchRunsRepository;
  jobPostings: IJobPostingsRepository;
  searchClient: SearchClient;
  now?: () => string;
  /** 每个 query 最多返回几条（成本闸，默认 5） */
  maxResultsPerQuery?: number;
  /** 单次搜岗最多执行几个 query（成本闸，默认 3） */
  maxQueries?: number;
}

export interface SearchTickOutcome {
  advanced: number;
  failed: number;
}

/** search-tick 循环：认领并执行最多 tickMaxRuns 个 queued 搜岗任务。 */
export async function runSearchTick(
  deps: RunSearchDeps,
  opts: { tickMaxRuns?: number } = {},
): Promise<SearchTickOutcome> {
  const now = deps.now?.() ?? new Date().toISOString();
  let advanced = 0;
  let failed = 0;
  for (let i = 0; i < (opts.tickMaxRuns ?? 5); i++) {
    const run = await deps.searchRuns.claimNextQueued(now);
    if (!run) break;
    const finished = await executeSearchRun(deps, run);
    if (finished.status === 'failed') failed += 1;
    else advanced += 1;
  }
  return { advanced, failed };
}

/** 执行一次搜岗（搜索→抽取→入库→回写）；返回回写后的 run（回写失败则原 run）。 */
export async function executeSearchRun(
  deps: RunSearchDeps,
  run: StoredSearchRun,
): Promise<StoredSearchRun> {
  const now = deps.now?.() ?? new Date().toISOString();
  const queries = run.conditions.queries.slice(0, deps.maxQueries ?? 3);
  const executed: string[] = [];
  const candidates: RawPostingCandidate[] = [];
  const seenUrls = new Set<string>();
  const searchErrors: string[] = [];

  for (const q of queries) {
    try {
      const items = await deps.searchClient.search(q, {
        maxResults: deps.maxResultsPerQuery ?? 5,
      });
      executed.push(q);
      for (const item of items) {
        const canon = canonicalizeUrl(item.url);
        if (!canon || seenUrls.has(canon)) continue;
        seenUrls.add(canon);
        const ext = extractJobFromSearchResult(item, run.conditions);
        if (!ext) continue;
        candidates.push({
          jobId: createHash('sha1').update(`websearch\0${canon}`).digest('hex').slice(0, 16),
          source: 'websearch',
          sourceUrl: canon,
          title: ext.title,
          company: ext.company,
          location: ext.location,
          remote: ext.remote,
          salaryMin: ext.salaryMin,
          salaryMax: ext.salaryMax,
          salaryCurrency: ext.salaryCurrency,
          tags: ext.tags,
          description: ext.description,
          fetchedAt: now,
          applyUrl: canon,
        });
      }
    } catch (err) {
      searchErrors.push(`${q}: ${(err as Error).message}`);
    }
  }

  // 入库（buildPosting 过 Zod；跨源疑似同岗键标记）
  const postings: Array<JobPosting & { normalizedKey: string; searchRunId?: string | null }> = [];
  for (const raw of candidates) {
    const built = buildPosting(raw);
    if (!built.ok) continue;
    postings.push({
      ...built.posting,
      normalizedKey: makeNormalizedKey(
        built.posting.title,
        built.posting.company,
        built.posting.location ?? null,
      ),
      searchRunId: run.runId,
    });
  }

  let newCount = 0;
  if (postings.length > 0) {
    const counts = await deps.jobPostings.upsertBatch(postings, now);
    newCount = counts.inserted;
  }

  // 状态判定：无搜索结果且全部 query 失败 → failed；部分失败 → partial；否则 done
  const allQueriesFailed = searchErrors.length > 0 && postings.length === 0;
  const status = allQueriesFailed ? 'failed' : searchErrors.length > 0 ? 'partial' : 'done';
  const error =
    searchErrors.length > 0
      ? `部分搜索失败：${searchErrors.slice(0, 3).join('；')}`
      : null;

  const finished = await deps.searchRuns.finish(run.runId, {
    status,
    queries: executed,
    resultsCount: seenUrls.size,
    newCount,
    error,
  }, now);
  return finished ?? run;
}
