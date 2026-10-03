/**
 * api_tokens 仓储契约——扩展长期 Bearer 凭证（决策 #22）。
 * 鉴权按 token_hash（SHA-256 hex）精确查找；服务端不存明文。
 * 滑动续期：命中 token 时 lastSeenAt 与 expiresAt 顺延至 now+ttl。
 */
import type { NewApiToken, StoredApiToken } from '../entities/index.js';

export interface IApiTokensRepository {
  create(token: NewApiToken): Promise<void>;
  /** 按 token_hash 查 active（未撤销、未过期）token，否则 undefined */
  getActiveByHash(tokenHash: string, nowIso: string): Promise<StoredApiToken | undefined>;
  /** 滑动续期：更新 last_seen_at 与 expires_at（= now + ttlMs） */
  touchAndSlide(id: string, nowIso: string, ttlMs: number): Promise<void>;
  /** 撤销：revoked_at 置值即失效（不可逆） */
  revoke(id: string, nowIso: string): Promise<void>;
  /** 某账号的未撤销 token 列表（授权管理页；按创建倒序） */
  listActiveByAccount(accountId: string, nowIso: string): Promise<StoredApiToken[]>;
  /** 运维清理：删除已撤销超过保留期或已过期超过保留期的 token，返回删除行数 */
  purgeExpired(nowIso: string, retainMs: number): Promise<number>;
}
