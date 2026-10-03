import type { StoredUserLlmConfig } from '../entities/index.js';

/**
 * user_llm_configs 仓储契约（迁移 025，BYOK 模型配置，design-llm-model-
 * provisioning-20261003 §4.3）。业务模块只依赖此异步接口，不感知方言。
 *
 * 安全不变量（决策 #21-1）：本仓储只读写密文字段 apiKeyEncrypted，明文 key
 * 的加解密发生在 api 层（LLM_ENC_KEY env），仓储永远见不到明文。
 */
export interface IUserLlmConfigsRepository {
  /** 按账号取配置（一账号一行）；无配置返回 undefined。 */
  getByAccountId(accountId: string): Promise<StoredUserLlmConfig | undefined>;
  /**
   * 写入/更新（upsert，主键 account_id）。apiKeyEncrypted 必须是已加密的
   * 密文；仓储不负责加密。返回落库后的配置。
   */
  upsert(input: StoredUserLlmConfig): Promise<StoredUserLlmConfig>;
  /** 清除配置（回落内置/503）；无配置为 no-op。 */
  deleteByAccountId(accountId: string): Promise<void>;
}
