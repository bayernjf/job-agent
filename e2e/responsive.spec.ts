import { test, expect } from '@playwright/test';
import { FIXTURE_PROFILE_ID } from './fixtures/sample-profile.js';

/**
 * 移动端响应式守护（2026-10-08 手机视口走查）：
 * 走查曾发现报告页头部徽章/按钮在 390px 被 flex 压成逐字竖排、首页输入框与
 * 按钮横排导致 placeholder 截断。这里以 iPhone 视口断言关键页面无横向溢出、
 * 头部控件保持自然宽度换行、首页表单纵向堆叠，防止回归。
 */
const NO_HORIZONTAL_OVERFLOW = async (page: import('@playwright/test').Page) => {
  const dims = await page.evaluate(() => ({
    vw: document.documentElement.clientWidth,
    docW: document.documentElement.scrollWidth,
    bodyW: document.body ? document.body.scrollWidth : 0,
  }));
  expect(dims.docW, `document scrollWidth ${dims.docW} exceeds viewport ${dims.vw}`).toBeLessThanOrEqual(
    dims.vw + 1,
  );
  expect(dims.bodyW).toBeLessThanOrEqual(dims.vw + 1);
  return dims;
};

test.describe('mobile responsive (390px)', () => {
  test.use({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 3,
  });

  test('home has no horizontal overflow and stacks the analyze form', async ({ page }) => {
    await page.goto('/zh-CN/');
    await expect(page.locator('.analyze-form')).toBeVisible();
    await NO_HORIZONTAL_OVERFLOW(page);

    // Input and submit button stack vertically at <=640px: the button spans the
    // full form width instead of squeezing the input on one row.
    const inputBox = await page.locator('.analyze-form .input-row .ja-input').boundingBox();
    const buttonBox = await page.locator('.analyze-form .input-row .ja-btn').boundingBox();
    expect(inputBox).toBeTruthy();
    expect(buttonBox).toBeTruthy();
    expect(Math.round(buttonBox!.width)).toBeGreaterThanOrEqual(Math.round(inputBox!.width) - 4);
    expect(buttonBox!.y).toBeGreaterThan(inputBox!.y);
  });

  test('report header badges/buttons wrap instead of collapsing to vertical text', async ({ page }) => {
    await page.goto(`/zh-CN/report/${FIXTURE_PROFILE_ID}`);
    await expect(page.locator('.profile-header')).toBeVisible();
    await NO_HORIZONTAL_OVERFLOW(page);

    // Every header badge/button keeps its label on a single horizontal line
    // (vertical CJK text would make scrollHeight far exceed a single line).
    const controls = page.locator('.header-meta .ja-badge, .header-meta .ja-btn');
    const count = await controls.count();
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < count; i++) {
      const box = await controls.nth(i).boundingBox();
      expect(box).toBeTruthy();
      // A control squeezed to one-character-per-line is narrower than 64px at
      // the base 14-16px font; natural wrapped controls are all wider than that.
      expect(box!.width).toBeGreaterThan(64);
    }
  });

  test('recruit gate and privacy page have no horizontal overflow', async ({ page }) => {
    await page.goto('/zh-CN/recruit');
    await NO_HORIZONTAL_OVERFLOW(page);
    await page.goto('/zh-CN/privacy');
    await NO_HORIZONTAL_OVERFLOW(page);
  });
});
