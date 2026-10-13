import type { JobSource } from '@jobagent/shared';
import type {
  JobPostingStatus,
  NewJobPosting,
  RecruiterPostingDraft,
  StoredJobPosting,
} from '../entities/index.js';

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
  /**
   * last_seen_at >= 该 ISO 时间＝"源站这一轮还列着它"。推荐给正在投简历的人时必须传
   * （决策 #25 之后的 C 端体验增量：不把已关闭的岗位当在招推荐）；不传＝ operator 面
   * （CLI / 列表 / MCP 检索）照旧看到全部 active 行，两种口径的差别是故意的。
   */
  seenAfter?: string;
  limit?: number;
  offset?: number;
  orderBy?: 'posted_desc' | 'posted_asc' | 'salary_desc';
  /**
   * 只看某个招聘方自建的岗位（决策 #25，B3-a 最小一刀）。
   * **不传＝只返回公开池**（`created_by_account_id IS NULL`）：默认值是安全侧，
   * 这样任何忘记加过滤的调用方都只会少看私有行，绝不会把别人的 JD 漏进公开池。
   */
  ownerAccountId?: string;
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
  /** 按搜岗 run 列出本次入库的岗位（source=websearch，run 关联列） */
  listBySearchRun(runId: string, limit?: number): Promise<StoredJobPosting[]>;
  /**
   * 招聘方发布一条自建 JD（决策 #25，B3-a 最小一刀）。身份三件套（`jobId`、
   * `source='recruiter'`、`sourceUrl='https://recruiter.invalid/<account>/<jobId>'`）
   * 与派生主键都由仓储生成——业务侧不该拼 DB 身份，而 `recruiter.invalid` 是 RFC 2606
   * 保留域，保证这个 URL 既过 schema 校验、又永不被当成真外链去抓。
   * `createdByAccountId` 是"私有岗位绝不进公开池"的唯一判据。
   */
  insertOwned(draft: RecruiterPostingDraft, now: string): Promise<StoredJobPosting>;
  /** 列出某招聘方自己发布的岗位（含已下线的，默认按发布时间倒序）。 */
  listOwned(
    accountId: string,
    opts?: { status?: JobPostingStatus; limit?: number; offset?: number },
  ): Promise<StoredJobPosting[]>;
  /**
   * 下线自己发布的岗位。行级归属：不存在或非本人一律返回 `undefined`，
   * 调用方据此回 404（不泄露该 id 是否存在）。
   */
  retireOwned(id: string, accountId: string, now: string): Promise<StoredJobPosting | undefined>;
}
