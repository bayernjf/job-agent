import { test, expect, type Page } from '@playwright/test';
import { FIXTURE_PROFILE_ID } from './fixtures/sample-profile.js';

/**
 * 前端主链路 E2E（#1）：首页语言协商/渲染、输入校验、analyze→轮询→跳转编排。
 * API 全部用 page.route mock，不依赖真实后端/GitHub，保证确定性。
 */

const MOCK_PROFILE_ID = FIXTURE_PROFILE_ID;

/**
 * 等待 Astro React island 在浏览器完成 hydration。
 * React 会在 <astro-island> 元素上建立 container fiber（__reactContainer$…），
 * 在此之前 fill/click 只作用于静态 SSR DOM，不会更新 React state（经典 hydration 竞态）。
 */
async function waitForHydrated(page: import('@playwright/test').Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const island = document.querySelector('astro-island');
      return !!island && Object.keys(island).some((k) => k.startsWith('__reactContainer'));
    },
    null,
    { timeout: 10000 },
  );
}

/** 拦截 analyze + jobs，模拟 queued → succeeded 的轮询过程 */
async function mockAnalyzeFlow(page: Page): Promise<void> {
  let pollCount = 0;
  await page.route('**/analyze', async (route) => {
    expect(route.request().method()).toBe('POST');
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({ jobId: 'job-mock-1', status: 'queued', dedup: false }),
    });
  });
  await page.route('**/jobs/job-mock-1', async (route) => {
    pollCount += 1;
    // 第一次返回 queued，第二次返回 succeeded（验证轮询逻辑）
    const body =
      pollCount < 2
        ? { id: 'job-mock-1', status: 'queued', stage: null, profileId: null }
        : { id: 'job-mock-1', status: 'succeeded', stage: 'L1', profileId: MOCK_PROFILE_ID };
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
}

test.describe('locale negotiation and home render', () => {
  test('root redirects to /en/ for English Accept-Language', async ({ browser }) => {
    const context = await browser.newContext({ locale: 'en-US' });
    const page = await context.newPage();
    await page.goto('/');
    await expect(page).toHaveURL(/\/en\/$/);
    await context.close();
  });

  test('root redirects to /zh-CN/ for Chinese Accept-Language', async ({ browser }) => {
    const context = await browser.newContext({ locale: 'zh-CN' });
    const page = await context.newPage();
    await page.goto('/');
    await expect(page).toHaveURL(/\/zh-CN\/$/);
    await context.close();
  });

  test('English home renders title, input and generate button', async ({ page }) => {
    await page.goto('/en/');
    await expect(page.getByRole('heading', { level: 1 })).toContainText(
      'Enter a GitHub username',
    );
    const input = page.getByLabel('GitHub username');
    await expect(input).toBeVisible();
    await expect(input).toHaveAttribute('placeholder', /torvalds/);
    await expect(page.getByRole('button', { name: 'Generate Profile' })).toBeVisible();
  });

  test('Chinese home renders localized copy', async ({ page }) => {
    await page.goto('/zh-CN/');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('输入 GitHub 用户名');
    await expect(page.getByRole('button', { name: '生成画像' })).toBeVisible();
  });
});

test.describe('AnalyzeForm flow', () => {
  test('shows validation error and sends no request for invalid username', async ({ page }) => {
    let analyzeCalled = false;
    await page.route('**/analyze', () => {
      analyzeCalled = true;
      return Promise.resolve();
    });
    await page.goto('/en/');
    await waitForHydrated(page);
    await page.getByLabel('GitHub username').fill('bad name!!');
    await page.getByRole('button', { name: 'Generate Profile' }).click();
    // 出现错误提示
    await expect(page.getByRole('alert')).toContainText('valid GitHub username');
    // 未发起任何分析请求
    expect(analyzeCalled).toBe(false);
  });

  test('submits username, polls job, and navigates to the report page', async ({ page }) => {
    await mockAnalyzeFlow(page);
    await page.goto('/en/');
    await waitForHydrated(page);

    await page.getByLabel('GitHub username').fill('torvalds');
    await page.getByRole('button', { name: 'Generate Profile' }).click();

    // 成功后应导航到 /en/report/<profileId>
    await page.waitForURL(new RegExp(`/en/report/${MOCK_PROFILE_ID}`), { timeout: 15000 });
  });

  test('shows error when analyze request fails', async ({ page }) => {
    await page.route('**/analyze', (route) =>
      route.fulfill({ status: 500, contentType: 'application/json', body: '{}' }),
    );
    await page.goto('/en/');
    await waitForHydrated(page);
    await page.getByLabel('GitHub username').fill('someone');
    await page.getByRole('button', { name: 'Generate Profile' }).click();
    await expect(page.getByRole('alert')).toBeVisible();
  });
});
