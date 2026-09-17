import { describe, expect, it } from 'vitest';
import { readStoredLocalProfile, writeStoredLocalProfile } from './local-profile-storage';

/**
 * 跨端档案 chrome.storage 读写薄壳的降级路径：单测环境（node/vitest）无 `chrome` 全局，
 * 必须安全返回空/静默跳过，绝不抛出阻塞主流程。
 */
describe('local-profile-storage (无 chrome 降级)', () => {
  it('readStoredLocalProfile 无 chrome 时返回空对象', async () => {
    await expect(readStoredLocalProfile()).resolves.toEqual({});
  });

  it('writeStoredLocalProfile 无 chrome 时静默跳过（不抛）', async () => {
    await expect(writeStoredLocalProfile({ email: 'a@b.c', phone: '123' })).resolves.toBeUndefined();
  });
});
