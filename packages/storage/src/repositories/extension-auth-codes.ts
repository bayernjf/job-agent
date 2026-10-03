/**
 * extension_auth_codes 仓储契约——一次性授权码（决策 #22）。
 * 单次消费语义在仓储层用原子 UPDATE 实现（WHERE used_at IS NULL 条件更新，
 * 返回受影响行数判定谁先消费），业务模块不感知方言。
 */
import type { NewExtensionAuthCode, StoredExtensionAuthCode } from '../entities/index.js';

export interface IExtensionAuthCodesRepository {
  create(code: NewExtensionAuthCode): Promise<void>;
  /** 原始行查找（不限状态，供 404/410/过期 的错误码判定） */
  getById(id: string): Promise<StoredExtensionAuthCode | undefined>;
  /** 未消费且未过期（expiresAt > nowIso）的 code，否则 undefined */
  getActive(id: string, nowIso: string): Promise<StoredExtensionAuthCode | undefined>;
  /**
   * 原子消费：仅当 used_at IS NULL 时置 used_at=nowIso，返回是否成功。
   * 并发双请求只有一个成功（防重放）；已消费/已过期返回 false。
   */
  consume(id: string, nowIso: string): Promise<boolean>;
  /** 运维清理：删除已过期或已消费超过保留期的 code，返回删除行数 */
  purgeExpired(nowIso: string, retainMs: number): Promise<number>;
}
