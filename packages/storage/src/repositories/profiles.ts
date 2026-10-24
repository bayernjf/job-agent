import type { EvidenceItem } from '@jobagent/shared';
import type {
  CandidateSearchQuery,
  CandidateSummary,
  NewProfile,
  ProfileStatus,
  StoredProfile,
} from '../entities/index.js';

/** `publishWithEvidenceAndJob` 的入参：一次分析的成功终态要落的全部内容。 */
export interface ProfilePublication {
  profile: NewProfile;
  evidence: EvidenceItem[];
  jobId: string;
  budgetUsed?: Record<string, number>;
  missing?: string[];
}

/**
 * profiles 仓储契约——业务模块只依赖此接口，不感知 SQLite/Postgres 方言。
 * 所有方法统一 async（Postgres 驱动为异步，SQLite 实现内部同步执行、对外同样返回 Promise）。
 *
 * 写入面刻意只有 `insert`、`updateStatus` 与原子发布 `publishWithEvidenceAndJob`：
 * 画像快照**不可变**（AGENTS 运行架构第 5 条），T28 之后不再存在"同一 profileId 换一份
 * 快照"的升级路径，因此也刻意不提供快照 PATCH。
 */
export interface IProfilesRepository {
  insert(profile: NewProfile): Promise<void>;
  /**
   * 「写画像快照 + 导入证据 + 标记任务成功」一体化原子操作（worker 成功路径专用）。
   *
   * 三步在**同一事务**内完成，所以进程在中间被杀绝不会留下半成品。此前是三次独立写，
   * 崩溃窗口有两个可见后果：① 有画像但任务仍 `running` → 被 reclaim 重跑再写**第二份**
   * 画像；② 孤儿画像对 `/candidates`（直读 `profiles.searchCandidates`）是可见的，
   * 招聘方会看到同一个 login 两次。两者都违背 AGENTS 运行架构第 3 条
   * 「一次分析永远只发布一份可分享结论」的意图（虽不违背其字面——profileId 不同）。
   */
  publishWithEvidenceAndJob(input: ProfilePublication): Promise<void>;
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
