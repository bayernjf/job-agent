/**
 * api_tokens 实体：扩展长期 Bearer 凭证（决策 #22，design-扩展登录态 §5）。
 *
 * 服务端只存 SHA-256 hex 摘要（tokenHash），明文仅在签发响应返回一次，绝不落库、
 * 不写日志、不可逆查。90 天滑动续期（命中即顺延 expiresAt 至 now+90d），
 * revokedAt 非 NULL 即失效；撤销不可逆（不留原值）。
 */

export interface StoredApiToken {
  /** 不透明 token id：tkn-<32B>（明文仅签发时返回一次） */
  id: string;
  /** 归属 accounts.id */
  accountId: string;
  /** SHA-256(token) 的 hex 摘要（鉴权查找键） */
  tokenHash: string;
  /** 显示名（工作台授权管理列表） */
  name: string;
  expiresAt: string;
  lastSeenAt: string;
  revokedAt: string | null;
  createdAt: string;
}

export interface NewApiToken {
  id: string;
  accountId: string;
  tokenHash: string;
  name: string;
  expiresAt: string;
}

/** Drizzle 查询返回的原始行（camelCase），两方言结构一致 */
export interface RawApiTokenRow {
  id: string;
  accountId: string;
  tokenHash: string;
  name: string;
  expiresAt: string;
  lastSeenAt: string;
  revokedAt: string | null;
  createdAt: string;
}

export function toStoredApiToken(row: RawApiTokenRow): StoredApiToken {
  return {
    id: row.id,
    accountId: row.accountId,
    tokenHash: row.tokenHash,
    name: row.name,
    expiresAt: row.expiresAt,
    lastSeenAt: row.lastSeenAt,
    revokedAt: row.revokedAt,
    createdAt: row.createdAt,
  };
}
