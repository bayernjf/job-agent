import { test, expect } from '@playwright/test';
import {
  FIXTURE_PROFILE_ID,
  FIXTURE_CLAIMED_PROFILE_ID,
  FIXTURE_SESSION_TOKEN,
} from './fixtures/sample-profile.js';

/**
 * 投递管道隐私 E2E（决策 #17-F11，handoff item60 T03b）。
 *
 * 判据在 SSR 侧（`canViewApplications`，与 API 的 `requireProfileOwner` 同一组存储行列值）：
 * - 画像**未认领** → 投递区块照常对匿名访客挂载（它没有可授权的主体，报告本就公开，
 *   匿名求职链路不受影响；这条由 recruiter-features.spec 正向覆盖）；
 * - 画像**已认领** → 区块只对本人出现。匿名访问者连"这里有投递数据"都不该看出来，
 *   所以是**不挂载**而不是挂载后再吃 401。
 *
 * 分享出去的 profileId 出现在每一条报告链接里，这就是本用例要守住的场景。
 */

const APPLICATIONS_COLLECTION_URL = '**/profiles/*/applications**';

test.beforeEach(async ({ page }) => {
  // SSR 决定挂不挂载；island 挂载后的读请求统一给空列表，保持确定性零网络。
  await page.route(APPLICATIONS_COLLECTION_URL, (route) =>
    route.fulfill({ status: 200, json: { items: [] } }),
  );
});

test.describe('claimed profile hides the application pipeline from strangers', () => {
  test('anonymous visitor sees no tracker section at all', async ({ page }) => {
    await page.goto(`/en/report/${FIXTURE_CLAIMED_PROFILE_ID}`);

    expect(await page.locator('.apptrk').count()).toBe(0);
    // 报告本身仍然可见（收紧的是投递数据，不是画像结论）
    await expect(page.locator('h1, .report-header, main').first()).toBeVisible();
  });

  test('the owner sees their own tracker', async ({ context, page }) => {
    await context.addCookies([
      { name: 'jobagent_session', value: FIXTURE_SESSION_TOKEN, domain: 'localhost', path: '/' },
    ]);
    await page.goto(`/en/report/${FIXTURE_CLAIMED_PROFILE_ID}`);

    const tracker = page.locator('.apptrk');
    await expect(tracker).toBeVisible();
    await expect(tracker).toContainText('Application tracker');
  });
});

test.describe('unclaimed profile keeps the anonymous journey working', () => {
  test('anonymous visitor still gets the tracker', async ({ page }) => {
    await page.goto(`/en/report/${FIXTURE_PROFILE_ID}`);

    await expect(page.locator('.apptrk')).toContainText('Application tracker');
  });
});
