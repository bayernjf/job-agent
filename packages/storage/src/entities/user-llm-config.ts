/**
 * user_llm_configs 实体（迁移 025，BYOK 模型配置，design-llm-model-provisioning
 * 20261003 §4.3）。与方言无关的领域类型 + 纯映射逻辑（sqlite/postgres 两套仓储共享）。
 *
 * 安全不变量（决策 #21-1）：apiKeyEncrypted 只存 AES-256-GCM 密文，明文 key 永不
 * 进库、不进日志、不进任何 API 响应（对外只给掩码）。一账号一行（决策 #21-6）。
 */
import type { StoredUserLlmConfig } from '@jobagent/shared';

/** Drizzle 查询返回的原始行（camelCase），两方言结构一致 */
export interface RawUserLlmConfigRow {
  accountId: string;
  provider: string;
  baseUrl: string;
  model: string;
  apiKeyEncrypted: string;
  createdAt: string;
  updatedAt: string;
}

/** 行 → 领域实体（透传；密文字段不在此做任何解密） */
export function toStoredUserLlmConfig(row: RawUserLlmConfigRow): StoredUserLlmConfig {
  return {
    accountId: row.accountId,
    provider: row.provider,
    baseUrl: row.baseUrl,
    model: row.model,
    apiKeyEncrypted: row.apiKeyEncrypted,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
