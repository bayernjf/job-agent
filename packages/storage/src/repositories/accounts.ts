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
}
