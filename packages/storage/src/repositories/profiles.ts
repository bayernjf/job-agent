import type { AbilityProfile } from '@jobagent/shared';
import type {
  CandidateSearchQuery,
  CandidateSummary,
  NewProfile,
  ProfileStatus,
  StoredProfile,
} from '../entities/index.js';

/**
 * profiles 仓储契约——业务模块只依赖此接口，不感知 SQLite/Postgres 方言。
 * 所有方法统一 async（Postgres 驱动为异步，SQLite 实现内部同步执行、对外同样返回 Promise）。
 *
 * 写入面刻意只有 `insert` 与 `updateStatus`：画像快照**不可变**（AGENTS 运行架构第 5 条），
 * T28 之后不再存在"同一 profileId 换一份快照"的升级路径，因此也刻意不提供快照 PATCH。
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
  /** 物理删除画像（T26 删除/解绑）；返回是否存在并被删除 */
  deleteById(id: string): Promise<boolean>;
  /** 把画像标记为本人已认领（subject_claimed=true，幂等）；不存在时静默无操作 */
  markClaimed(id: string): Promise<void>;
  /**
   * 解除本人认领（subject_claimed=false，幂等）；不存在时静默无操作。
   * 与 deleteById 不同：只翻认领标记，不删画像/证据/投递/面试，分享链接继续有效。
   */
  unmarkClaimed(id: string): Promise<void>;
  /**
   * S3 软挂起标记：写入 UTC ISO8601（有未决移除申请）或 null（清除挂起）。
   * 挂起只影响"是否继续分发该画像"（by-subject 解析 / 人才库检索 / 报告页标注），
   * 不改变快照内容与已认领本人的自助删除权限；不存在时静默无操作。
   */
  setRemovalRequestedAt(id: string, requestedAt: string | null): Promise<void>;
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
