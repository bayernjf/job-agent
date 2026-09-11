import type { NewProfile, ProfileStatus, StoredProfile } from '../entities/index.js';

/**
 * profiles 仓储契约——业务模块只依赖此接口，不感知 SQLite/Postgres 方言。
 * 所有方法统一 async（Postgres 驱动为异步，SQLite 实现内部同步执行、对外同样返回 Promise）。
 */
export interface IProfilesRepository {
  insert(profile: NewProfile): Promise<void>;
  getById(id: string): Promise<StoredProfile | undefined>;
  listBySubject(
    subjectPlatform: string,
    subjectLogin: string,
    limit?: number,
  ): Promise<StoredProfile[]>;
  latestBySubject(
    subjectPlatform: string,
    subjectLogin: string,
  ): Promise<StoredProfile | undefined>;
  updateStatus(id: string, status: ProfileStatus): Promise<void>;
}
