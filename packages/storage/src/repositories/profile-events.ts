import type { ProfileEventRecord } from '../entities/profile-event.js';

/**
 * profile_events 仓储（迁移 043，评审 P1-1 修复）。
 * 只追加，不回改：无 UPDATE/DELETE 口。方言差异只允许出现在实现内部。
 */
export interface IProfileEventsRepository {
  /** 追加一条画像审计事件（id/createdAt 已由调用方注入） */
  insert(row: ProfileEventRecord): Promise<void>;

  /** 按画像列出审计事件（created_at 升序，复核/申诉时回溯用） */
  listByProfile(profileId: string): Promise<ProfileEventRecord[]>;
}
