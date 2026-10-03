import type { ProviderIdentity, StoredAccount } from '../entities/index.js';

/**
 * accounts 仓储契约——OAuth 登录账号（决策 #1-A/#6-A）。
 * 业务模块只依赖此异步接口，不感知 SQLite/Postgres 方言。
 */
export interface IAccountsRepository {
  /**
   * OAuth 登录 upsert：按 (platform, providerAccountId) 命中已有账号则刷新
   * login/name/email/avatar，否则新建（id 由调用方生成）。返回落库后的账号。
   */
  upsertFromProvider(input: { id: string; identity: ProviderIdentity }): Promise<StoredAccount>;
  getById(id: string): Promise<StoredAccount | undefined>;
  getByProvider(
    platform: string,
    providerAccountId: string,
  ): Promise<StoredAccount | undefined>;
  /** 记录本人认领的画像快照 id（accounts.claimed_profile_id）；账号不存在返回 undefined */
  setClaimedProfile(accountId: string, profileId: string): Promise<StoredAccount | undefined>;
  /** 撤销认领（B2 自助删除画像时把 claimed_profile_id 置空）；账号不存在返回 undefined */
  clearClaimedProfile(accountId: string): Promise<StoredAccount | undefined>;
  /**
   * 按画像撤销认领指针（S3 复核批准走 CLI，拿不到 accountId）：把
   * claimed_profile_id 等于该画像的账号一律置空，返回被清理的账号数。
   */
  clearClaimedProfileByProfileId(profileId: string): Promise<number>;
  /**
   * F10 招聘方显式自声明（决策 #17 第一期）：把 recruiter_declared_at 置为当前
   * UTC ISO8601；幂等（已声明则保留原时刻），账号不存在返回 undefined。
   */
  declareRecruiter(accountId: string, nowIso: string): Promise<StoredAccount | undefined>;
  /**
   * 撤销招聘方声明：recruiter_declared_at 置 NULL（既有面试/投递数据不删，
   * 见设计 §2.1 反制通道）；幂等，账号不存在返回 undefined。
   */
  revokeRecruiter(accountId: string): Promise<StoredAccount | undefined>;
  /**
   * 运维清理（cron 用）：删除从未认领画像（claimed_profile_id 为空）、updated_at 早于
   * 保留期截止，且当前没有任何未过期会话的账号，返回删除行数。再次登录会按
   * (platform, provider_account_id) 重新 upsert，故删除无认领记录的闲置账号不丢数据。
   * F10：已声明招聘方的账号（recruiter_declared_at 非空）永不被清理——招聘方通常
   * 不认领自己的画像，且声明不得被后台任务静默重置（设计 §7.1）。
   */
  deleteUnclaimed(nowIso: string, retainMs: number): Promise<number>;
  /**
   * 设置平台管理员标记（迁移 023，决策 #21-5：ADMIN_ACCOUNT_LOGINS env 白名单
   * 登录时自动置位）。幂等；账号不存在返回 undefined。
   */
  setAdmin(accountId: string, isAdmin: boolean): Promise<StoredAccount | undefined>;
}
