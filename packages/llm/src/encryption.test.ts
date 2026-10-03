import { describe, expect, it } from 'vitest';
import { decryptApiKey, encryptApiKey, maskApiKey } from './encryption.js';

describe('BYOK api key 加密（AES-256-GCM）', () => {
  it('加密 → 解密还原明文；两次加密密文不同（随机 IV）', () => {
    const encKey = 'some-arbitrary-env-string';
    const plaintext = 'sk-4oZXZz0E0pJVpKYJxjqMqbVS2DtT31tNUWRA6fcKJpkdSxLd';
    const a = encryptApiKey(plaintext, encKey);
    const b = encryptApiKey(plaintext, encKey);
    expect(a).not.toBe(b); // IV 随机，密文不同
    expect(decryptApiKey(a, encKey)).toBe(plaintext);
    expect(decryptApiKey(b, encKey)).toBe(plaintext);
  });

  it('错误 encKey 解密失败（不静默返回垃圾）', () => {
    const cipher = encryptApiKey('sk-secret-1234', 'key-a');
    expect(() => decryptApiKey(cipher, 'key-b')).toThrow();
  });

  it('密文被篡改（任一字节）→ 认证失败抛错', () => {
    const cipher = encryptApiKey('sk-secret-1234', 'k');
    const bytes = Buffer.from(cipher, 'base64');
    bytes[bytes.length - 1] ^= 0xff;
    expect(() => decryptApiKey(bytes.toString('base64'), 'k')).toThrow();
  });

  it('短/长 encKey 都可用（SHA-256 派生固定 32 字节）', () => {
    const plaintext = 'sk-x';
    expect(decryptApiKey(encryptApiKey(plaintext, 'a'), 'a')).toBe(plaintext);
    expect(decryptApiKey(encryptApiKey(plaintext, 'a'.repeat(100)), 'a'.repeat(100))).toBe(
      plaintext,
    );
  });
});

describe('maskApiKey（对外只给掩码）', () => {
  it('sk- 前缀 + 末4位；中间部分绝不回显', () => {
    expect(maskApiKey('sk-abcdef1234')).toBe('sk-****1234');
  });
  it('非 sk- 前缀保留前两段字符风格', () => {
    expect(maskApiKey('ab-cdef5678')).toMatch(/^ab-\*\*\*\*5678$/);
  });
  it('过短 key 整串星号', () => {
    expect(maskApiKey('sk-12')).toBe('sk-****');
  });
});
