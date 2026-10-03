/**
 * BYOK API key 加密（decision #21-1：服务端 AES-256-GCM 加密列，LLM_ENC_KEY env）。
 *
 * 不变量：
 * - 明文 key 只存在于请求处理瞬间；落库/日志/响应一律只出现密文或掩码。
 * - encKey 是任意长度 env 字符串，用 SHA-256 派生 32 字节密钥（不要求用户提供
 *   恰好 32 字节，避免配置摩擦）。
 * - 密文格式：base64(iv 12B || authTag 16B || ciphertext)，自包含、可迁移。
 * - 未配置 LLM_ENC_KEY 时 BYOK 保存端点应拒绝（503），不静默降级为明文。
 */
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';

const IV_LEN = 12;
const TAG_LEN = 16;
const ALGO = 'aes-256-gcm';

function deriveKey(encKey: string): Buffer {
  return createHash('sha256').update(encKey, 'utf8').digest();
}

/** 加密明文 API key；返回 base64(iv||tag||ciphertext)。 */
export function encryptApiKey(plaintext: string, encKey: string): string {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, deriveKey(encKey), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString('base64');
}

/** 解密；encKey 错误或密文被篡改时抛错（调用方按 502/500 处理，不回显明文）。 */
export function decryptApiKey(payload: string, encKey: string): string {
  const raw = Buffer.from(payload, 'base64');
  if (raw.length < IV_LEN + TAG_LEN + 1) {
    throw new Error('invalid encrypted payload length');
  }
  const iv = raw.subarray(0, IV_LEN);
  const tag = raw.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ciphertext = raw.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv(ALGO, deriveKey(encKey), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

/** 掩码：`sk-****<末4位>`（key 过短时整串星号，绝不回显中间部分）。 */
export function maskApiKey(plaintext: string): string {
  const trimmed = plaintext.trim();
  // 短于「前缀 3 字符 + 4 位尾」就整串掩掉，避免漏出半截密钥
  if (trimmed.length <= 7) return 'sk-****';
  const tail = trimmed.slice(-4);
  const head = trimmed.includes('sk-') ? 'sk-' : `${trimmed.slice(0, 2)}-`;
  return `${head}****${tail}`;
}
