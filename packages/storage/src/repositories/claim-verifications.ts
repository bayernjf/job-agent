import type { NewClaimVerification, StoredClaimVerification } from '../entities/index.js';

/**
 * claim_verifications 仓储契约（决策 #23 批次 1，2026-10-05）。
 * 业务模块只依赖此异步接口，不感知 SQLite/Postgres 方言。
 *
 * 刻意**不提供任意条件的查询**：读取口只有"某张画像的全部"与"单条 id"两种，
 * 因为这条数据是第三方带来的隐私信息（§6），广泛讀口等于泄漏面。
 * 也**不提供覆盖画像之外的更新**：结论与它产生的规则版本是绑定的，改判必须由
 * 内核重算生成新行，而不是就地 patch（否则同一 id 会指向两套输出）。
 */
export interface IClaimVerificationsRepository {
  insert(row: NewClaimVerification): Promise<void>;
  getById(id: string): Promise<StoredClaimVerification | undefined>;
  /** 某画像快照下的全部结论，按创建时间升序（稳定顺序＝可复核） */
  listByProfile(profileId: string): Promise<StoredClaimVerification[]>;
  /**
   * 批量计数：返回入参画像各自的核验结论条数（/recruit 列表的"已核验条数"）。
   * 刻意只回 `profileId → count`，不回任何声明文本，宽聚合口不扩大原文泄漏面（§6）。
   * 没有任何结论的画像不出现在结果里（调用方按 0 处理）。
   */
  countByProfiles(profileIds: readonly string[]): Promise<Map<string, number>>;
  /**
   * 物理删除一条：声明是可撤回的用户输入，不进快照。
   * 找不到该 id 返回 false（幂等，供"撤回"这类重复点击使用）。
   */
  delete(id: string): Promise<boolean>;
  /** B2 自助删画像时级联清理该画像上的全部结论；无行也成功 */
  deleteByProfile(profileId: string): Promise<void>;
}
