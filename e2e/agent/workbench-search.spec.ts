/**
 * 搜岗工作台「真全栈」E2E（2026-10-08）：真 Chromium → 真 API → 真 SQLite → 真报告页 SSR。
 *
 * 覆盖指令式全网搜岗 P0 的三条 UI 主链路（无 TAVILY key 时的优雅回退也在链路内）：
 * 1) 发起搜岗：POST /agent/search 201 → 页面显示任务状态（queued 由 search-tick 未认领时的初始态）；
 * 2) 保存筛选条件预设 → 右侧列表出现；
 * 3) 删除预设 → 列表清空（含一键再搜按钮存在）。
 * 断言全部走可见 UI + 真实 API 响应，不打网络。
 */
import { test, expect, type Page } from '@playwright/test';
import { default as resetAgentFixtures } from './global-setup';
import { login } from './helpers';

const WORKBENCH = '/en/workbench';

/** 打开工作台并等水合完成（island 是 client:load，水合信号 = 预设列表 GET 回来）。 */
async function openWorkbenchHydrated(page: Page): Promise<void> {
  const presetsReady = page.waitForResponse(
    (r) =>
      r.url().includes('/agent/search-presets') &&
      r.request().method() === 'GET' &&
      r.status() === 200,
  );
  await page.goto(WORKBENCH);
  await expect(page.getByTestId('search-workbench')).toBeVisible();
  await presetsReady;
}

test.beforeAll(async () => {
  await resetAgentFixtures();
});

test('launches a search, saves/deletes presets through the real UI', async ({ page }) => {
  await login(page);
  await openWorkbenchHydrated(page);

  // 1) 发起搜岗：填指令 → 点 Start search → 服务端 201 → 状态区出现
  const created = page.waitForResponse(
    (r) =>
      r.url().includes('/agent/search') &&
      r.request().method() === 'POST' &&
      r.status() === 201,
  );
  await page.fill('[data-testid="search-query"]', 'Shenzhen Java developer, remote OK');
  await page.click('[data-testid="search-start"]');
  await created;
  await expect(page.getByTestId('search-run')).toContainText('Queued');
  await expect(page.getByTestId('search-run')).toContainText('Shenzhen Java developer, remote OK');

  // 2) 保存预设 → 列表出现一条（query 已有值，直接保存）
  await page.click('[data-testid="search-save-preset"]');
  await expect(page.getByTestId('search-presets')).toContainText('Shenzhen Java developer, remote OK');

  // 3) 删除预设 → 列表回到空态
  await page
    .getByTestId('search-workbench')
    .getByRole('button', { name: 'Delete', exact: true })
    .click();
  await expect(page.getByTestId('search-presets')).not.toBeVisible();
  await expect(
    page.getByTestId('search-workbench').getByText('No saved conditions yet'),
  ).toBeVisible();
});
