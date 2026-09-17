import { describe, expect, it } from 'vitest';
import { EXTENSION_ID, fetchExtensionLocalProfile, pushExtensionLocalProfile } from './extension-bridge';

/**
 * 报告页 ↔ 扩展桥接的降级路径：单测环境（node/vitest）无 window/chrome，
 * 必须安全返回 undefined / 静默跳过，绝不抛出阻塞简历生成。
 */
describe('extension-bridge (无 chrome 降级)', () => {
  it('EXTENSION_ID 是 32 位 a-p 字符（Chrome 扩展 ID 格式）', () => {
    expect(EXTENSION_ID).toMatch(/^[a-p]{32}$/);
  });

  it('无 chrome 时 fetchExtensionLocalProfile 返回 undefined', async () => {
    await expect(fetchExtensionLocalProfile()).resolves.toBeUndefined();
  });

  it('无 chrome 时 pushExtensionLocalProfile 静默跳过（不抛）', async () => {
    await expect(pushExtensionLocalProfile({ email: 'a@b.c' })).resolves.toBeUndefined();
  });
});
