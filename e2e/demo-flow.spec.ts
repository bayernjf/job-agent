import { test, expect, type Page, type Route } from '@playwright/test';
import { FIXTURE_PROFILE_ID } from './fixtures/sample-profile.js';

/**
 * 演示模式前端 E2E（design-demo-mode-20260915 §9/§14 report 清单）：
 * - AnalyzeForm 遇 403 DEMO_REQUIRED 自动建会话并重试一次
 * - 429 DEMO_QUOTA_EXCEEDED 显示配额文案且不跳转
 * - DemoBanner 仅在 demo 身份出现，可退出
 * - PresetList 只展示 ready 预置并直达报告页
 * API 全部 page.route mock，零真实后端。
 */

async function waitForHydrated(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const islands = Array.from(document.querySelectorAll('astro-island'));
      return islands.some((el) => Object.keys(el).some((k) => k.startsWith('__reactContainer')));
    },
    null,
    { timeout: 10000 },
  );
}

/** 统一兜底 DemoBanner/PresetList 的拉取，避免未 mock 时打到 Astro 404 */
async function mockDemoSupport(
  page: Page,
  me: unknown = { kind: 'anonymous' },
  presets: unknown[] = [],
): Promise<void> {
  await page.route('**/demo/me', (route) => route.fulfill({ status: 200, json: me as object }));
  await page.route('**/demo/presets', (route) =>
    route.fulfill({ status: 200, json: presets }),
  );
}

const succeedJob = (route: Route, jobId: string) =>
  route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ id: jobId, status: 'succeeded', stage: 'L1', profileId: FIXTURE_PROFILE_ID }),
  });

test.describe('AnalyzeForm demo bootstrap', () => {
  test('auto-creates a demo session on 403 DEMO_REQUIRED and retries once', async ({ page }) => {
    let analyzeCalls = 0;
    let sessionCalls = 0;
    await mockDemoSupport(page);
    await page.route('**/demo/sessions', (route) => {
      sessionCalls += 1;
      return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ kind: 'demo' }) });
    });
    await page.route('**/analyze', (route) => {
      analyzeCalls += 1;
      if (analyzeCalls === 1) {
        return route.fulfill({
          status: 403,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'demo required', code: 'DEMO_REQUIRED' }),
        });
      }
      return route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ jobId: 'job-demo-1', status: 'queued', dedup: false }),
      });
    });
    await page.route('**/jobs/job-demo-1', (route) => succeedJob(route, 'job-demo-1'));

    await page.goto('/en/');
    await waitForHydrated(page);
    await page.getByLabel('username').fill('newcomer');
    await page.getByRole('button', { name: 'Generate Profile' }).click();

    await page.waitForURL(new RegExp(`/en/report/${FIXTURE_PROFILE_ID}`), { timeout: 15000 });
    expect(sessionCalls).toBe(1); // 自动建了一次会话
    expect(analyzeCalls).toBe(2); // 首次 403 + 重试一次
  });

  test('shows quota copy on 429 DEMO_QUOTA_EXCEEDED and does not navigate', async ({ page }) => {
    await mockDemoSupport(page);
    await page.route('**/demo/sessions', (route) =>
      route.fulfill({ status: 201, body: JSON.stringify({ kind: 'demo' }) }),
    );
    await page.route('**/analyze', (route) =>
      route.fulfill({
        status: 429,
        contentType: 'application/json',
        body: JSON.stringify({
          error: 'quota',
          code: 'DEMO_QUOTA_EXCEEDED',
          analyzeQuota: 3,
          analyzeUsed: 3,
          analyzeRemaining: 0,
          resetAt: '2026-09-22T12:00:00.000Z',
        }),
      }),
    );

    await page.goto('/en/');
    await waitForHydrated(page);
    await page.getByLabel('username').fill('someone');
    await page.getByRole('button', { name: 'Generate Profile' }).click();

    const alert = page.getByRole('alert');
    await expect(alert).toBeVisible();
    await expect(alert).toContainText('used up');
    // 仍停留在首页
    await expect(page).toHaveURL(/\/en\/$/);
  });
});

test.describe('DemoBanner', () => {
  test('shows remaining quota for a demo identity and exits to anonymous', async ({ page }) => {
    let meCalls = 0;
    await page.route('**/demo/me', (route) => {
      meCalls += 1;
      // 首次为 demo，退出刷新后变匿名
      const body =
        meCalls === 1
          ? {
              kind: 'demo',
              sessionId: 'demo-x',
              analyzeQuota: 3,
              analyzeUsed: 1,
              analyzeRemaining: 2,
              expiresAt: '2026-09-22T12:00:00.000Z',
            }
          : { kind: 'anonymous' };
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    });
    let exitCalls = 0;
    await page.route('**/demo/exit', (route) => {
      exitCalls += 1;
      return route.fulfill({ status: 200, body: JSON.stringify({ kind: 'anonymous' }) });
    });
    await page.route('**/demo/presets', (route) => route.fulfill({ status: 200, json: [] }));

    await page.goto('/en/');
    const banner = page.locator('.demo-banner');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('Demo mode');
    await expect(banner).toContainText('2 more analysis');

    await page.getByRole('button', { name: 'Exit demo' }).click();
    expect(exitCalls).toBe(1);
    await expect(banner).toHaveCount(0);
  });

  test('renders no banner for anonymous identity', async ({ page }) => {
    await mockDemoSupport(page, { kind: 'anonymous' });
    await page.goto('/en/');
    await waitForHydrated(page);
    await expect(page.locator('.demo-banner')).toHaveCount(0);
  });
});

test.describe('PresetList', () => {
  test('lists only ready presets and opens the cached report', async ({ page }) => {
    await mockDemoSupport(
      page,
      { kind: 'anonymous' },
      [
        { platform: 'github', login: 'ready-one', authenticity: 'likely_authentic', profileId: FIXTURE_PROFILE_ID, ready: true },
        { platform: 'github', login: 'not-ready', authenticity: 'unknown', profileId: null, ready: false },
      ],
    );

    await page.goto('/en/');
    const list = page.locator('.demo-presets');
    await expect(list).toBeVisible();
    await expect(list).toContainText('ready-one');
    await expect(list).not.toContainText('not-ready');

    await page.getByRole('link', { name: 'View sample report' }).click();
    await page.waitForURL(new RegExp(`/en/report/${FIXTURE_PROFILE_ID}`), { timeout: 15000 });
  });
});
