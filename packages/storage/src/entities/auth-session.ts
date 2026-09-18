/**
 * auth_sessions 实体：登录用户的不透明服务端会话（账号里程碑，2026-09-18）。
 *
 * 与 demo_sessions 对称，但归属正式账号：id 即 HttpOnly Cookie 值（32 随机字节，
 * 不可猜）。服务端存会话以支持登出 / 撤销 / 过期，不使用 JWT；不存 IP 等 PII。
 */

export type AuthSessionStatus = 'active' | 'revoked';

export const AUTH_SESSION_STATUSES: readonly AuthSessionStatus[] = ['active', 'revoked'];

export interface StoredAuthSession {
  /** 不透明会话 token：ses-<32 随机字节>，同时是 Cookie 值 */
  id: string;
  /** 归属 accounts.id */
  accountId: string;
  /** 过期时间（ISO8601） */
  expiresAt: string;
  status: AuthSessionStatus;
  createdAt: string;
  lastSeenAt: string;
}

export interface NewAuthSession {
  id: string;
  accountId: string;
  expiresAt: string;
}

/** Drizzle 查询返回的原始行（camelCase），两方言结构一致 */
export interface RawAuthSessionRow {
  id: string;
  accountId: string;
  expiresAt: string;
  status: string;
  createdAt: string;
  lastSeenAt: string;
}

export function toStoredAuthSession(row: RawAuthSessionRow): StoredAuthSession {
  const status: AuthSessionStatus = (AUTH_SESSION_STATUSES as readonly string[]).includes(row.status)
    ? (row.status as AuthSessionStatus)
    : 'active';
  return {
    id: row.id,
    accountId: row.accountId,
    expiresAt: row.expiresAt,
    status,
    createdAt: row.createdAt,
    lastSeenAt: row.lastSeenAt,
  };
}
