import type {
  JobPreferencePatch,
  NewJobPreference,
  StoredJobPreference,
} from '../entities/index.js';

/**
 * job_preferences 仓储契约（求职 Agent 阶段 1，迁移 018）。
 *
 * 业务模块只依赖此异步接口，不感知 SQLite/Postgres 方言。偏好集是登录用户的私有数据，
 * 因此读写都以 accountId 为作用域：`listByAccount` 是唯一列表入口，`getById`/`update`/
 * `delete` 的归属校验由调用方用 `StoredJobPreference.accountId` 完成（本层不做身份判断）。
 */
export interface IJobPreferencesRepository {
  /** 插入一套偏好；未提供的集合/布尔/数字走列默认值 */
  insert(pref: NewJobPreference): Promise<void>;
  getById(id: string): Promise<StoredJobPreference | undefined>;
  /** 列出某账号的偏好集，按 created_at 倒序，默认最多 50 条 */
  listByAccount(accountId: string, limit?: number): Promise<StoredJobPreference[]>;
  /**
   * 局部更新：只写 patch 里**显式提供**的字段（`undefined` 一律不改，null 是合法值，
   * 用于清空 salaryMinUsd）；JSON 数组列由本层 stringify。
   * 目标不存在时返回 undefined。
   */
  update(
    id: string,
    patch: JobPreferencePatch,
    updatedAt: string,
  ): Promise<StoredJobPreference | undefined>;
  /** 物理删除；返回是否真的删掉了一行 */
  delete(id: string): Promise<boolean>;
}
