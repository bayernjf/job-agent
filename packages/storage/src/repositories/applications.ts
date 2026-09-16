import type {
  ApplicationPatch,
  NewApplication,
  StoredApplication,
} from '../entities/index.js';

/**
 * applications 仓储契约——求职者画像侧投递记录（痛点解决方案批次 2）。
 * 业务模块只依赖此异步接口，不感知 SQLite/Postgres 方言。
 * 当前无账号体系，所有读写以 profileId 为作用域。
 */
export interface IApplicationsRepository {
  insert(application: NewApplication): Promise<void>;
  getById(id: string): Promise<StoredApplication | undefined>;
  /** 列出某画像的全部投递，按 applied_at 倒序 */
  listByProfile(profileId: string): Promise<StoredApplication[]>;
  /** 局部更新状态/备注/投递时间/链接；返回更新后的行，不存在返回 undefined */
  update(id: string, patch: ApplicationPatch): Promise<StoredApplication | undefined>;
}
