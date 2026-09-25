import type { JobSource } from '@jobagent/shared';
import type { JobPostingStatus, NewJobPosting, StoredJobPosting } from '../entities/index.js';

/** 岗位列表过滤条件（MVP 用 SQL LIKE + 结构化过滤，不上全文搜索）。 */
export interface JobPostingQuery {
  /** 自由文本：拆词后每个词都要在 title/company/tags 之一命中（词间 AND，大小写不敏感） */
  keyword?: string;
  /** 只看这些源 */
  sources?: JobSource[];
  remote?: boolean;
  /** 公司名精确匹配（归一化后由调用方负责） */
  company?: string;
  /** 命中任一标签即可（OR） */
  tags?: string[];
  status?: JobPostingStatus;
  /** 只保留 salary_max（缺失时回退 salary_min）>= 该值的岗位 */
  salaryMinUsd?: number;
  /** posted_at >= 该 ISO 时间 */
  postedAfter?: string;
  limit?: number;
  offset?: number;
  orderBy?: 'posted_desc' | 'posted_asc' | 'salary_desc';
}

export interface UpsertCounts {
  inserted: number;
  updated: number;
  unchanged: number;
}

/**
 * job_postings 仓储契约（职位聚合），业务模块只依赖此异步接口。
 * 同源去重唯一键：(source, source_url)。
 */
export interface IJobPostingsRepository {
  /**
   * 幂等批量 upsert（单事务）：
   * - 不存在：插入，first_seen_at = last_seen_at = fetched_at = now；
   * - 已存在且可变内容变化：更新内容，保留 first_seen_at，刷新 last_seen_at/fetched_at；
   * - 已存在且内容无变化：只刷新 last_seen_at，计入 unchanged。
   */
  upsertBatch(postings: NewJobPosting[], now: string): Promise<UpsertCounts>;
  search(query: JobPostingQuery): Promise<StoredJobPosting[]>;
  /** 按源统计在招岗位数量（可指定状态，默认 active） */
  countBySource(status?: JobPostingStatus): Promise<Record<string, number>>;
  /** T24：只统计 last_seen_at >= cutoffIso 的 active 岗位（过期行不再冒充 active，即使未跑 markStale） */
  countActiveFresh(cutoffIso: string): Promise<Record<string, number>>;
  /** last_seen_at < cutoffIso 的 active 岗位置 inactive，返回受影响行数 */
  markStale(cutoffIso: string): Promise<number>;
  getById(id: string): Promise<StoredJobPosting | undefined>;
}
