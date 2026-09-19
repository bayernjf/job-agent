import type { NewAuthSession, StoredAuthSession } from '../entities/index.js';

/**
 * auth_sessions 仓储契约——登录用户的不透明服务端会话。
 * 与 demo_sessions 仓储对称，但归属正式账号；业务模块不感知方言。
 */
export interface IAuthSessionsRepository {
  create(session: NewAuthSession): Promise<void>;
  /** 仅返回 active 且未过期（expiresAt > nowIso）的会话，否则 undefined */
  getActive(id: string, nowIso: string): Promise<StoredAuthSession | undefined>;
  /** 刷新 last_seen_at（每次携带有效会话的请求调用） */
  touch(id: string, nowIso: string): Promise<void>;
  /** 登出：把会话置为 revoked */
  revoke(id: string): Promise<void>;
  /**
   * 运维清理（cron 用，参照 demo_sessions.purgeExpired）：删除已过期超过保留期，
   * 或已撤销（revoked）且最后使用早于保留期的会话，返回删除行数。
   * retainMs 为额外宽限保留窗口，避免刚过期/刚登出的行被立即物理删除。
   */
  purgeExpired(nowIso: string, retainMs: number): Promise<number>;
}
