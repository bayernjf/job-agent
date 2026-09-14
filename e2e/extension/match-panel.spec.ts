import { test, expect } from './extension-test.js';
import { THREE_TIER_MATCHES, EMPTY_MATCHES } from './fixtures.js';
import type { Page } from '@playwright/test';

/**
 * 扩展面板岗位匹配区块的真实浏览器 E2E（design-extension-e2e-20260914.md）。
 * 验证 content script 注入 → Shadow DOM 面板 → 画像加载 → 匹配区块渲染/展开/四态。
 * API 全部由 fixture route 拦截，确定性、零网络。文案断言用英文（默认 locale）。
 */

// 输入用户名并提交，等画像区出现。
async function loadProfile(page: Page): Promise<void> {
  await page.getByPlaceholder('e.g. sindresorhus').fill('e2e-fixture-user');
  await page.getByRole('button', { name: 'Load verified profile' }).click();
  await page.locator('.ja-result').waitFor({ timeout: 5000 });
}

test.describe('extension match panel', () => {
  test('injects floating button and opens the panel', async ({ extPage, openPanel }) => {
    // 悬浮按钮在 ATS 页自动注入
    await expect(extPage.locator('.ja-fab')).toBeVisible();
    await openPanel();
    await expect(extPage.locator('#jobagent-autofill-panel .ja-panel')).toBeVisible();
    await expect(extPage.getByPlaceholder('e.g. sindresorhus')).toBeVisible();
  });

  test('renders three-tier match list with score class, title@company and skill chips', async ({
    extPage,
    openPanel,
  }) => {
    await openPanel();
    await loadProfile(extPage);

    const items = extPage.locator('.ja-match-list .ja-match-item');
    await expect(items).toHaveCount(3);

    // 三档 class 与 shared.matchScoreTier 接线一致（顺序同 fixture：high/mid/low）
    await expect(items.nth(0).locator('.ja-match-score-high')).toHaveText('6');
    await expect(items.nth(1).locator('.ja-match-score-mid')).toHaveText('6');
    await expect(items.nth(2).locator('.ja-match-score-low')).toHaveText('2');

    // 标题@公司 + 外链
    const first = items.nth(0);
    await expect(first.locator('.ja-match-title-text')).toHaveText('Senior TypeScript Engineer');
    await expect(first.locator('.ja-match-company')).toHaveText('@ Acme Corp');
    await expect(first.locator('.ja-match-job')).toHaveAttribute('href', 'https://example.test/job-high');
    await expect(first.locator('.ja-match-job')).toHaveAttribute('target', '_blank');

    // 命中技能 chip
    await expect(first.locator('.ja-match-chip')).toHaveText(['TypeScript']);
    await expect(items.nth(1).locator('.ja-match-chip')).toHaveText(['TypeScript', 'React']);
  });

  test('expands match basis with field breakdown and traceable evidence link', async ({
    extPage,
    openPanel,
  }) => {
    await openPanel();
    await loadProfile(extPage);

    const firstBasis = extPage.locator('.ja-match-list .ja-match-item').nth(0).locator('.ja-match-basis');
    await expect(firstBasis).toBeAttached();
    await firstBasis.locator('summary').click();

    // 分数分解 title/tags/desc
    const breakdown = firstBasis.locator('.ja-match-breakdown-chip');
    await expect(breakdown).toHaveText(['title 3', 'tags 2', 'desc 1']);

    // 技能理由（depth + fields + score）
    await expect(firstBasis.locator('.ja-match-skill-reason')).toContainText('TypeScript');
    await expect(firstBasis.locator('.ja-match-skill-depth')).toHaveText(' · proficient');

    // 证据外链（来自顶层 evidence 字典）
    const evidenceLink = firstBasis.locator('.ja-match-evidence a');
    await expect(evidenceLink).toHaveCount(1);
    await expect(evidenceLink).toHaveAttribute('href', 'https://github.com/acme/awesome-lib/pull/12');
    await expect(evidenceLink).toHaveAttribute('target', '_blank');
  });

  test('shows empty state when no jobs match and refresh is available', async ({
    extPage,
    openPanel,
    setMatchResponder,
  }) => {
    setMatchResponder(() => ({ status: 200, body: EMPTY_MATCHES }));
    await openPanel();
    await loadProfile(extPage);

    await expect(extPage.locator('.ja-match-empty')).toBeVisible();
    await expect(extPage.locator('.ja-match-empty')).toHaveText('No matching jobs');
    await expect(extPage.locator('.ja-match-list')).toHaveCount(0);
    await expect(extPage.locator('.ja-match-refresh')).toBeVisible();
  });

  test('shows error state and recovers after retry', async ({
    extPage,
    openPanel,
    setMatchResponder,
  }) => {
    // 第一次 500，点 Retry 后第二次 200 恢复
    let calls = 0;
    setMatchResponder(() => {
      calls += 1;
      return calls === 1 ? { status: 500, body: { error: 'boom' } } : { status: 200, body: THREE_TIER_MATCHES };
    });

    await openPanel();
    await loadProfile(extPage);

    await expect(extPage.locator('.ja-match-error')).toBeVisible({ timeout: 5000 });
    const retry = extPage.locator('.ja-match-retry');
    await expect(retry).toBeVisible();
    await retry.click();

    await expect(extPage.locator('.ja-match-list .ja-match-item')).toHaveCount(3, { timeout: 5000 });
    await expect(extPage.locator('.ja-match-error')).toHaveCount(0);
  });
});

test.describe('extension platform switcher', () => {
  test('shows GitHub and Gitee buttons and sends platform in analyze request', async ({
    extPage,
    openPanel,
  }) => {
    await openPanel();

    // 平台切换按钮可见
    await expect(extPage.getByRole('button', { name: 'GitHub' })).toBeVisible();
    await expect(extPage.getByRole('button', { name: 'Gitee' })).toBeVisible();

    // 捕获 POST /analyze body
    let postedPlatform = '';
    await extPage.route('**/analyze', async (route) => {
      const body = JSON.parse(route.request().postData() ?? '{}');
      postedPlatform = body.platform;
      await route.fulfill({ json: { profileId: 'prof-test' } });
    });

    // 切换到 Gitee
    await extPage.getByRole('button', { name: 'Gitee' }).click();
    await expect(extPage.getByRole('button', { name: 'Gitee' })).toHaveClass(/ja-platform-btn--active/);

    await extPage.getByPlaceholder('e.g. sindresorhus').fill('gitee-user');
    await extPage.getByRole('button', { name: 'Load verified profile' }).click();

    // 等画像区出现
    await extPage.locator('.ja-result').waitFor({ timeout: 5000 });
    expect(postedPlatform).toBe('gitee');
  });
});
