import type { InterviewPatchInput, InterviewStatus } from '@jobagent/shared';
import type { NewInterview, StoredInterview } from '../entities/index.js';

/** listByOwner 的可选过滤（创建者由参数强制，不接受调用方任意指定） */
export interface InterviewListFilter {
  profileId?: string;
  status?: InterviewStatus;
}

/**
 * interviews 仓储契约——招聘方侧面试计划（handoff item45）。
 * 业务模块只依赖此异步接口，不感知 SQLite/Postgres 方言。
 * 行级归属：所有列表查询都以 createdByAccountId 为强制作用域，
 * API 层在 update 前再用 getById 校验归属，非本人资源按 404 处理。
 */
export interface IInterviewsRepository {
  insert(interview: NewInterview): Promise<void>;
  getById(id: string): Promise<StoredInterview | undefined>;
  /** 列出某账号创建的面试（可按候选人/状态过滤），按 scheduled_start 倒序 */
  listByOwner(
    createdByAccountId: string,
    filter?: InterviewListFilter,
  ): Promise<StoredInterview[]>;
  /** 局部更新排期/状态/结果；返回更新后的行，不存在返回 undefined */
  update(id: string, patch: InterviewPatchInput): Promise<StoredInterview | undefined>;
}
