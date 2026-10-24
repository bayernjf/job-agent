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
  UsageRecorder,
} from '@jobagent/storage';
import { extractJobFromSearchResult } from './jd-extract.js';
import type { SearchClient, SearchQueryObserver, SearchResultItem } from './types.js';

/**
 * ATS 详情页域名（混合召回，T1-1）：通用搜索的结果常被 Indeed/LinkedIn 等
 * SEO 聚合页占据；额外用 Tavily include_domains 限定这些域名搜一次，保证
 * 真实岗位详情页召回。只用第一条 query 追加一次，成本仅 +1 次调用。
 */
const ATS_INCLUDE_DOMAINS = [
  'jobs.lever.co',
  'boards.greenhouse.io',
  'wellfound.com',
  'jobs.ashbyhq.com',
  'apply.workable.com',
  'myworkdayjobs.com',
];

export interface RunSearchDeps {
  searchRuns: ISearchRunsRepository;
  jobPostings: IJobPostingsRepository;
  searchClient: SearchClient;
  now?: () => string;
  /** 每个 query 最多返回几条（成本闸，默认 5） */
  maxResultsPerQuery?: number;
  /** 单次搜岗最多执行几个 query（成本闸，默认 3） */
  maxQueries?: number;
  /**
   * 用量记录器（决策 #25 ④ Wave C）：一次任务结束时把实际发出的 Tavily 查询数
   * 记为一条 websearch 事件；缺省走 null 语义，不影响主流程。
   */
  usage?: UsageRecorder;
}

/**
 * 滞留 `running` 的搜岗任务超过该阈值即落终态 `failed`。
 * 默认 10 分钟＝CF Worker 每 5 分钟档的两个周期，远大于单个 run 的正常耗时
 * （至多 3 次 Tavily 查询 + JD 抽取），因此不会回收正在进行中的 run。
 */
export const SEARCH_RUN_STALE_MS = 10 * 60 * 1000;

export interface SearchTickOutcome {
  advanced: number;
  failed: number;
  /** 本轮把滞留 running 落成 failed 的条数；刻意不重放（见 ISearchRunsRepository 契约） */
  reclaimed: number;
}

/** search-tick 循环：先回收滞留 running，再认领并执行最多 tickMaxRuns 个 queued 搜岗任务。 */
export async function runSearchTick(
  deps: RunSearchDeps,
  opts: { tickMaxRuns?: number; reclaimStaleMs?: number } = {},
): Promise<SearchTickOutcome> {
  const now = deps.now?.() ?? new Date().toISOString();
  // 先回收：serverless 平台可能在执行中切断 tick（CF Worker 的 CPU/时长上限），
  // run 于是停在 running；而 claimNextQueued 只认 queued，没有这一步它永远卡住、
  // 前端轮询永不收敛，且 Tavily 的额度已经真实花掉。
  const reclaimed = await deps.searchRuns.reclaimStaleRunning(
    opts.reclaimStaleMs ?? SEARCH_RUN_STALE_MS,
    now,
  );
  let advanced = 0;
  let failed = 0;
  for (let i = 0; i < (opts.tickMaxRuns ?? 5); i++) {
    const run = await deps.searchRuns.claimNextQueued(now);
    if (!run) break;
    const finished = await executeSearchRun(deps, run);
    if (finished.status === 'failed') failed += 1;
    else advanced += 1;
  }
  return { advanced, failed, reclaimed };
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
  // 计量（决策 #25 ④ Wave C）：SearchClient 每成功受理一次查询回调一次（失败不回调），
  // 任务结束时按 queriesSent 记一条 websearch 事件——发出即计入，后续抽取/落库失败不清零。
  let queriesSent = 0;
  const onQuery: SearchQueryObserver = () => {
    queriesSent += 1;
  };

  /** 把一批搜索结果去重、抽取后并入候选（通用搜索与 ATS 召回共用）。 */
  const ingestItems = (items: SearchResultItem[]): void => {
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
  };

  for (const q of queries) {
    try {
      const items = await deps.searchClient.search(q, {
        maxResults: deps.maxResultsPerQuery ?? 5,
        onQuery,
      });
      executed.push(q);
      ingestItems(items);
    } catch (err) {
      searchErrors.push(`${q}: ${(err as Error).message}`);
    }
  }

  // ATS 域混合召回：第一条 query 额外限定 ATS 域名搜一次（+1 调用，失败不致命）
  const firstQuery = queries[0];
  if (firstQuery) {
    try {
      const atsItems = await deps.searchClient.search(firstQuery, {
        maxResults: deps.maxResultsPerQuery ?? 5,
        includeDomains: ATS_INCLUDE_DOMAINS,
        onQuery,
      });
      executed.push(`${firstQuery} [ats]`);
      ingestItems(atsItems);
    } catch (err) {
      searchErrors.push(`ats: ${(err as Error).message}`);
    }
  }

  // 计量落库（决策 #25 ④ Wave C）：在入库阶段之前记录——只要 Tavily 查询真实发出
  // 就计入（后续 JD 抽取/落库失败不影响）；一条没发（queries 为空/全部失败未受理）不记。
  if (queriesSent > 0) {
    await deps.usage?.record({
      accountId: run.accountId,
      category: 'search',
      feature: 'websearch',
      billingSource: 'platform',
      provider: deps.searchClient.provider,
      model: null,
      promptTokens: null,
      completionTokens: null,
      quantity: queriesSent,
    });
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
