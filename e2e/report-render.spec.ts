import { test, expect } from '@playwright/test';
import { FIXTURE_PROFILE_ID, FIXTURE_FUSED_PROFILE_ID, FIXTURE_LOGIN } from './fixtures/sample-profile.js';

/**
 * 报告页 SSR E2E（#1）：fixture 画像由 globalSetup 写入临时 SQLite，
 * 验证报告页关键区块渲染、双语路由、不存在画像的安全回退。
 */

test.describe('report page SSR render', () => {
  test('renders fixture profile sections in English', async ({ page }) => {
    await page.goto(`/en/report/${FIXTURE_PROFILE_ID}`);

    // 头部：展示名 + 登录名
    await expect(page.locator('h1.login')).toContainText('E2E Fixture User');
    await expect(page.getByText(`@${FIXTURE_LOGIN}`)).toBeVisible();

    // 概述 headline（画像数据，与语言无关）
    await expect(page.locator('.headline')).toContainText('reliable full-stack developer');

    // 能力标签（.skill-tag 内还含深度子标签，故用 hasText 而非精确文本）
    await expect(page.locator('.skill-tag', { hasText: 'TypeScript' })).toBeVisible();
    await expect(page.locator('.skill-tag', { hasText: 'React' })).toBeVisible();

    // 真实性信号
    await expect(page.getByText('External PRs merged')).toBeVisible();

    // 外部协作
    await expect(page.getByText('octo/awesome-lib#12')).toBeVisible();

    // 面试题
    await expect(page.getByText('Walk through your most complex external PR.')).toBeVisible();

    // 盲区
    await expect(page.getByText(/Private contribution graph/)).toBeVisible();
  });

  test('renders the same fixture under Chinese route', async ({ page }) => {
    await page.goto(`/zh-CN/report/${FIXTURE_PROFILE_ID}`);
    await expect(page).toHaveURL(new RegExp(`/zh-CN/report/${FIXTURE_PROFILE_ID}`));
    await expect(page.locator('h1.login')).toContainText('E2E Fixture User');
    await expect(page.locator('.skill-tag', { hasText: 'TypeScript' })).toBeVisible();
  });

  test('redirects to home with notfound for an unknown profile', async ({ page }) => {
    await page.goto('/en/report/prof-does-not-exist-xyz');
    await page.waitForURL(/\/en\/\?notfound=1/, { timeout: 10000 });
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  });

  test('does not show the fused badge on a single-source profile', async ({ page }) => {
    await page.goto(`/en/report/${FIXTURE_PROFILE_ID}`);
    await expect(page.locator('.ja-badge--fused')).toHaveCount(0);
  });

  test('shows the GitHub+Gitee fused badge on the all-platform profile (English)', async ({ page }) => {
    await page.goto(`/en/report/${FIXTURE_FUSED_PROFILE_ID}`);
    const badge = page.locator('.profile-header .ja-badge--fused');
    await expect(badge).toBeVisible();
    await expect(badge).toContainText('GitHub + Gitee fused');
  });

  test('shows the fused badge in Chinese under the zh-CN route', async ({ page }) => {
    await page.goto(`/zh-CN/report/${FIXTURE_FUSED_PROFILE_ID}`);
    const badge = page.locator('.profile-header .ja-badge--fused');
    await expect(badge).toBeVisible();
    await expect(badge).toContainText('双源融合');
  });
});
