import { test, expect } from '@playwright/test';

/**
 * 隐私政策页 E2E（CWS 上架要求可公开访问的隐私政策 URL）：
 * 中英双语静态渲染、footer 入口、robots 允许收录（审核员/搜索引擎可达）。
 * 纯静态 SSR，不依赖 API/DB。
 */

test.describe('privacy policy page', () => {
  test('renders the English privacy policy with key sections and contact', async ({ page }) => {
    await page.goto('/en/privacy');
    await expect(page).toHaveURL(/\/en\/privacy$/);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Privacy Policy');
    // 关键章节（英文）
    await expect(page.getByRole('heading', { level: 2, name: '1. Information we process' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: '2. Information we do NOT collect' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: '5. Data retention and deletion' })).toBeVisible();
    // 核心隐私承诺：联系方式不上传
    await expect(page.locator('body')).toContainText('never uploaded');
    // 联系邮箱
    await expect(page.locator('body')).toContainText('dispute@job-agent.bayjf.com');
    // 受托处理方表格
    await expect(page.getByRole('cell', { name: /Vercel/ }).first()).toBeVisible();
  });

  test('renders the Chinese privacy policy', async ({ page }) => {
    await page.goto('/zh-CN/privacy');
    await expect(page).toHaveURL(/\/zh-CN\/privacy$/);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('隐私政策');
    await expect(page.getByRole('heading', { level: 2, name: '1. 我们处理哪些信息' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: '2. 我们不收集哪些信息' })).toBeVisible();
    await expect(page.locator('body')).toContainText('绝不上传');
    await expect(page.locator('body')).toContainText('dispute@job-agent.bayjf.com');
  });

  test('footer links to the locale-specific privacy page', async ({ page }) => {
    await page.goto('/en/');
    const footerLink = page.locator('footer a[href="/en/privacy"]');
    await expect(footerLink).toBeVisible();
    await expect(footerLink).toContainText('Privacy');

    await page.goto('/zh-CN/');
    const zhFooterLink = page.locator('footer a[href="/zh-CN/privacy"]');
    await expect(zhFooterLink).toBeVisible();
    await expect(zhFooterLink).toContainText('隐私政策');
  });

  test('is indexable (robots index,follow) so reviewers and search engines reach it', async ({ page }) => {
    await page.goto('/en/privacy');
    const robots = await page.locator('meta[name="robots"]').getAttribute('content');
    expect(robots).toBe('index,follow');
  });
});
