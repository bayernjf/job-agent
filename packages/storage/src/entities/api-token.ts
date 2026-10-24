/**
 * api_tokens 实体：扩展长期 Bearer 凭证（决策 #22，design-扩展登录态 §5）。
 *
 * 服务端只存 SHA-256 hex 摘要（tokenHash），明文仅在签发响应返回一次，绝不落库、
 * 不写日志、不可逆查。迁移 041 起 id 是不透明 UUID（此前误存明文 token，
 * 见审查 P0-2）；tokenLast4 只供授权列表展示真实指纹，不足以还原 token。
 * 90 天滑动续期（命中即顺延 expiresAt 至 now+90d）；revokedAt 非 NULL 即失效。
 */

export interface StoredApiToken {
  /** 不透明 token id：UUID（迁移 041 起；绝不等于明文 token） */
  id: string;
  /** 明文 token 的末 4 位，仅用于授权管理列表展示指纹 */
  tokenLast4: string;
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
  /** 随机 UUID（randomUUID），与明文 token 无关 */
  id: string;
  /** 明文 token 的末 4 位（由签发方在响应前截取） */
  tokenLast4: string;
  accountId: string;
  tokenHash: string;
  name: string;
  expiresAt: string;
}

/** Drizzle 查询返回的原始行（camelCase），两方言结构一致 */
export interface RawApiTokenRow {
  id: string;
  tokenLast4: string;
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
    tokenLast4: row.tokenLast4,
    accountId: row.accountId,
    tokenHash: row.tokenHash,
    name: row.name,
    expiresAt: row.expiresAt,
    lastSeenAt: row.lastSeenAt,
    revokedAt: row.revokedAt,
    createdAt: row.createdAt,
  };
}
