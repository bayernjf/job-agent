import type { NewSearchPreset, StoredSearchPreset } from '../entities/index.js';

/**
 * search_presets 仓储契约（迁移 032，设计 §3）。
 *
 * 业务模块只依赖此异步接口，不感知 SQLite/Postgres 方言。预设是登录用户的私有
 * 数据，读写都以 accountId 为作用域；`getById`/`delete` 的归属校验由调用方用
 * `StoredSearchPreset.accountId` 完成（本层不做身份判断）。
 */
export interface ISearchPresetsRepository {
  /** 插入预设；(account_id, query) 冲突时按 query 幂等更新（upsert） */
  upsert(preset: NewSearchPreset): Promise<void>;
  getById(id: string): Promise<StoredSearchPreset | undefined>;
  /** 列出某账号的预设，按 created_at 倒序，默认最多 50 条 */
  listByAccount(accountId: string, limit?: number): Promise<StoredSearchPreset[]>;
  /** 物理删除；返回是否真的删掉了一行 */
  delete(id: string): Promise<boolean>;
  /** 清空某账号全部预设（仅本人作用域）。返回删除条数。 */
  deleteAllByAccount(accountId: string): Promise<number>;
}
