/**
 * search_runs 实体：一次指令式全网搜岗任务（迁移 032，设计 §3）。
 *
 * 生命周期：queued（等待 search-tick 认领）→ running → done / partial / failed，
 * 由 cron 驱动的 serverless 执行（与 analysis_jobs/agent-tick 同构）。conditions
 * 的单一事实源在 `@jobagent/shared`（SearchConditionsSchema）。
 */
import {
  SEARCH_RUN_STATUSES,
  SearchConditionsSchema,
  SearchRunStatusSchema,
  type SearchConditions,
  type SearchRunStatus,
} from '@jobagent/shared';
import { parseJson } from './analysis-job.js';

export interface RawSearchRunRow {
  runId: string;
  accountId: string;
  presetId: string | null;
  query: string;
  conditions: string;
  status: string;
  queries: string;
  resultsCount: number;
  newCount: number;
  matchedCount: number;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface StoredSearchRun {
  runId: string;
  accountId: string;
  /** 关联预设（直接输入发起的为 null） */
  presetId: string | null;
  /** 本次执行的原始指令（来自输入或预设） */
  query: string;
  conditions: SearchConditions;
  status: SearchRunStatus;
  /** 实际执行的 query 列表 */
  queries: string[];
  resultsCount: number;
  newCount: number;
  matchedCount: number;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NewSearchRun {
  runId: string;
  accountId: string;
  presetId?: string | null;
  query: string;
  conditions: SearchConditions;
  status?: SearchRunStatus;
  createdAt: string;
  updatedAt: string;
}

/** finish() 可写的字段（状态 + 统计 + 错误原因）；其余字段不可改 */
export interface SearchRunFinishPatch {
  status: SearchRunStatus;
  queries?: string[];
  resultsCount?: number;
  newCount?: number;
  matchedCount?: number;
  error?: string | null;
}

export function toStoredSearchRun(row: RawSearchRunRow): StoredSearchRun {
  const statusParsed = SearchRunStatusSchema.safeParse(row.status);
  if (!statusParsed.success) {
    throw new Error(`search run ${row.runId}: invalid status "${row.status}"`);
  }
  const conditionsParsed = SearchConditionsSchema.safeParse(parseJson(row.conditions));
  if (!conditionsParsed.success) {
    throw new Error(`search run ${row.runId}: invalid conditions JSON (${conditionsParsed.error.message})`);
  }
  const queries = parseJson(row.queries);
  return {
    runId: row.runId,
    accountId: row.accountId,
    presetId: row.presetId,
    query: row.query,
    conditions: conditionsParsed.data,
    status: statusParsed.data,
    queries: Array.isArray(queries) ? queries.filter((q): q is string => typeof q === 'string') : [],
    resultsCount: row.resultsCount,
    newCount: row.newCount,
    matchedCount: row.matchedCount,
    error: row.error,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** 状态全集（shared 单一事实源，这里仅导出类型供契约消费） */
export const SEARCH_RUN_STATUSES_LIST = SEARCH_RUN_STATUSES;
