/**
 * OAuth state 签名（平台无关，账号里程碑 2026-09-18；2026-09-19 抽为共享模块）。
 *
 * state 用 HMAC-SHA256 签名（`nonce.mac`），配合回调时比对 state Cookie 防 CSRF。
 * GitHub 与 Gitee 两条 web flow 共用同一实现；仅用 node:crypto，无第三方依赖。
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** 生成签名 state：`nonce.mac`，nonce 随机、mac 为 HMAC-SHA256(base64url)。 */
export function generateOAuthState(secret: string): string {
  const nonce = randomBytes(16).toString('base64url');
  return `${nonce}.${stateMac(secret, nonce)}`;
}

/** 校验 state 签名（常量时间比较）；格式错误或签名不符返回 false。 */
export function verifyOAuthState(state: string | undefined | null, secret: string): boolean {
  if (!state) return false;
  const dot = state.lastIndexOf('.');
  if (dot <= 0) return false;
  const nonce = state.slice(0, dot);
  const mac = state.slice(dot + 1);
  const expected = stateMac(secret, nonce);
  const actualBuf = Buffer.from(mac);
  const expectedBuf = Buffer.from(expected);
  if (actualBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(actualBuf, expectedBuf);
}

function stateMac(secret: string, nonce: string): string {
  return createHmac('sha256', secret).update(nonce).digest('base64url');
}
