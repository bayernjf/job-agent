import type { JobPosting, JobSource } from '@jobagent/shared';
import type { JobHttpClient } from '../types.js';

export interface CollectContext {
  /** 本轮采集时间（ISO），作为发布时间缺失时的回退 */
  fetchedAt: string;
  http: JobHttpClient;
}

export interface CollectResult {
  /** 已通过契约校验的岗位 */
  postings: JobPosting[];
  /** 原始命中但未通过清洗/校验的条数 */
  invalid: number;
}

/**
 * 一个岗位数据源适配器：collect 负责「抓取 + parse」，返回已通过契约校验的岗位。
 * parse 逻辑应同时以纯函数形式导出，便于用录制夹具单测（不打网络）。
 */
export interface JobSourceAdapter {
  readonly source: JobSource;
  collect(ctx: CollectContext): Promise<CollectResult>;
}
