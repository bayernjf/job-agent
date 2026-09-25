import type { AbilityProfile } from '@jobagent/shared';
import type {
  CandidateSearchQuery,
  CandidateSummary,
  NewProfile,
  ProfileStatus,
  StoredProfile,
} from '../entities/index.js';

/** L0 早返回升级（T25）：同一 profileId 从 partial:L0 快照升级为全量快照。 */
export interface ProfileSnapshotPatch {
  snapshot: AbilityProfile;
  analyzerVersion: string;
  analysisLayers: string[];
  dataWindowSince: string;
  dataWindowUntil: string;
  status: ProfileStatus;
}

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
  /** 升级已落库画像的快照（L0 partial → 全量 complete/partial，T25）；行不存在时静默无操作 */
  updateSnapshot(id: string, patch: ProfileSnapshotPatch): Promise<void>;
  /** 物理删除画像（T26 删除/解绑）；返回是否存在并被删除 */
  deleteById(id: string): Promise<boolean>;
  /** 把画像标记为本人已认领（subject_claimed=true，幂等）；不存在时静默无操作 */
  markClaimed(id: string): Promise<void>;
  /**
   * 企业侧人才检索（筛选工作台 P-A/P-B）：仓储只按 status='complete' 粗筛并给出
   * 扫描上限，技能/真实性/置信度/关键词的精细过滤与排序由 entities 的纯函数完成
   * （snapshot 是 JSON，避免双方言 JSON SQL 差异）。
   */
  searchCandidates(query: CandidateSearchQuery): Promise<{
    items: CandidateSummary[];
    total: number;
  }>;
}
