/**
 * extension_auth_codes 实体：一次性授权码（决策 #22，design-扩展登录态 §5）。
 *
 * 工作台为已登录账号签发，经 externally_connectable + S7 origin 校验通道传给扩展；
 * 扩展一次性兑换成 api_token。id 即明文 code（ext-code-<32B>）、绑定签发账号；
 * usedAt 非 NULL 即已消费（防重放）；过期行由清理任务删除。
 */

export interface StoredExtensionAuthCode {
  /** 一次性授权码（ext-code-<32B>，明文即凭证） */
  id: string;
  /** 签发账号 accounts.id */
  accountId: string;
  /** 过期时间（ISO8601） */
  expiresAt: string;
  /** 消费时刻；非 NULL 即已使用 */
  usedAt: string | null;
  createdAt: string;
}

export interface NewExtensionAuthCode {
  id: string;
  accountId: string;
  expiresAt: string;
}

/** Drizzle 查询返回的原始行（camelCase），两方言结构一致 */
export interface RawExtensionAuthCodeRow {
  id: string;
  accountId: string;
  expiresAt: string;
  usedAt: string | null;
  createdAt: string;
}

export function toStoredExtensionAuthCode(row: RawExtensionAuthCodeRow): StoredExtensionAuthCode {
  return {
    id: row.id,
    accountId: row.accountId,
    expiresAt: row.expiresAt,
    usedAt: row.usedAt,
    createdAt: row.createdAt,
  };
}
