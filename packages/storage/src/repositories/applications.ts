import type {
  ApplicationPatch,
  NewApplication,
  StoredApplication,
} from '../entities/index.js';

/**
 * applications 仓储契约——求职者画像侧投递记录（痛点解决方案批次 2）。
 * 业务模块只依赖此异步接口，不感知 SQLite/Postgres 方言。
 * 读写以 profileId 为作用域；013 起另带行级归属（决策 #17-F11）。
 */
export interface IApplicationsRepository {
  insert(application: NewApplication): Promise<void>;
  getById(id: string): Promise<StoredApplication | undefined>;
  /** 列出某画像的全部投递，按 applied_at 倒序 */
  listByProfile(profileId: string): Promise<StoredApplication[]>;
  /**
   * 局部更新状态/备注/投递时间/链接；不存在返回 undefined。
   *
   * `ownerAccountId` 一旦传入即启用**行级归属校验**：目标行有主且主不是该账号时
   * 返回 undefined（调用方据此回 404，不区分"不存在"与"不归你"，避免泄露他人
   * 投递记录的存在性）；无主行（013 之前的历史行与匿名写入）沿用现状仍可改。
   * **不传则完全不校验** —— 因此面向用户的端点必须传，内部批量推进才可省略。
   */
  update(
    id: string,
    patch: ApplicationPatch,
    ownerAccountId?: string | null,
  ): Promise<StoredApplication | undefined>;
}
