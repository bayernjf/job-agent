import { test, expect } from './extension-test.js';
import { THREE_TIER_MATCHES, EMPTY_MATCHES } from './fixtures.js';
import { FIXTURE_PROFILE_ID } from '../fixtures/sample-profile.js';
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
  // The first request goes through the background relay; on a cold SW it can be slow.
  await page.locator('.ja-result').waitFor({ timeout: 15_000 });
}

test.describe('extension match panel', () => {
  test('injects floating button and opens the panel', async ({ extPage, openPanel }) => {
    // 悬浮按钮在 ATS 页自动注入
    await expect(extPage.locator('.ja-fab')).toBeVisible();
    await openPanel();
    await expect(extPage.locator('#jobagent-autofill-panel .ja-panel')).toBeVisible();
    await expect(extPage.getByPlaceholder('e.g. sindresorhus')).toBeVisible();

    // Regression: tokens.css/panel.css must be exposed via web_accessible_resources so
    // they actually apply inside the Shadow DOM (otherwise the panel renders unstyled).
    const styles = await extPage.locator('#jobagent-autofill-overlay').evaluate((host) => {
      const sr = host.shadowRoot as ShadowRoot;
      return {
        panelWidth: getComputedStyle(sr.querySelector('.ja-panel') as Element).width,
        fabBg: getComputedStyle(sr.querySelector('.ja-fab') as Element).backgroundColor,
      };
    });
    expect(styles.panelWidth).toBe('320px');
    expect(styles.fabBg).toBe('rgb(22, 163, 74)'); // --ja-color-accent (green-600), not the unstyled default button grey
  });

  test('links to the web demo without sharing extension credentials', async ({ extPage, openPanel }) => {
    await openPanel();
    const link = extPage.locator('.ja-web-demo');
    await expect(link).toBeVisible();
    await expect(link).toContainText(/free demo/i);
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', /noopener/);
    // 指向网页端语言首页
    await expect(link).toHaveAttribute('href', /\/en\/$/);
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

  test('renders a targeted-resume deep link per matched job (report page + resumeJob, no demo marker)', async ({
    extPage,
    openPanel,
  }) => {
    await openPanel();
    await loadProfile(extPage);

    const items = extPage.locator('.ja-match-list .ja-match-item');
    await expect(items).toHaveCount(3);

    // 每个匹配岗位都有"生成简历"CTA（仅当后端返回内部 posting.id）
    const firstCta = items.nth(0).locator('.ja-match-resume');
    await expect(firstCta).toBeVisible();
    await expect(firstCta).toHaveText('Build a targeted resume');
    await expect(firstCta).toHaveAttribute('target', '_blank');
    await expect(firstCta).toHaveAttribute('rel', /noopener/);

    // 深链 = 报告页 + locale + profileId + ?resumeJob=<内部岗位 id>，不含任何 demo/会话标识
    const href = (await firstCta.getAttribute('href')) ?? '';
    expect(href).toMatch(/\/en\/report\/[^?]+\?resumeJob=row-job-high$/);
    expect(href).not.toMatch(/demo|session|cookie/i);

    await expect(items.nth(2).locator('.ja-match-resume')).toHaveAttribute('href', /resumeJob=row-job-low$/);
  });

  test('local details expose both LinkedIn and personal site inputs (field parity with report page)', async ({
    extPage,
    openPanel,
  }) => {
    await openPanel();
    await loadProfile(extPage);

    const details = extPage.locator('.ja-result .ja-details');
    await details.locator('summary').click();

    // 两端本地档案字段对齐：扩展面板同时有 LinkedIn 与 Personal site（此前缺 personalSite）
    const linkedinInput = details.getByLabel('LinkedIn');
    const siteInput = details.getByLabel('Personal site');
    await expect(linkedinInput).toBeVisible();
    await expect(siteInput).toBeVisible();

    // 受控输入可填且值保留（保存与 ATS 投影由 shared 纯函数单测覆盖）
    await siteInput.fill('https://alice.dev');
    await expect(siteInput).toHaveValue('https://alice.dev');
    await linkedinInput.fill('https://www.linkedin.com/in/alice');
    await expect(linkedinInput).toHaveValue('https://www.linkedin.com/in/alice');
  });
});

test.describe('extension platform switcher', () => {
  test('shows GitHub, Gitee and fused buttons and sends platform in analyze request', async ({
    extPage,
    openPanel,
    lastAnalyzeBody,
  }) => {
    await openPanel();

    // 平台切换按钮可见
    await expect(extPage.getByRole('button', { name: 'GitHub' })).toBeVisible();
    await expect(extPage.getByRole('button', { name: 'Gitee' })).toBeVisible();
    await expect(extPage.getByRole('button', { name: 'Fused' })).toBeVisible();

    // 切换到 Gitee
    await extPage.getByRole('button', { name: 'Gitee' }).click();
    await expect(extPage.getByRole('button', { name: 'Gitee' })).toHaveClass(/ja-platform-btn--active/);

    await extPage.getByPlaceholder('e.g. sindresorhus').fill('gitee-user');
    await extPage.getByRole('button', { name: 'Load verified profile' }).click();

    // 等画像区出现（/analyze 经 service worker 代发，由 context 级路由捕获请求体）
    await extPage.locator('.ja-result').waitFor({ timeout: 5000 });
    expect((lastAnalyzeBody() as { platform?: string }).platform).toBe('gitee');
  });

  test('sends platform=all when the fused option is selected', async ({
    extPage,
    openPanel,
    lastAnalyzeBody,
  }) => {
    await openPanel();

    // 切换到 GitHub + Gitee 融合
    await extPage.getByRole('button', { name: 'Fused' }).click();
    await expect(extPage.getByRole('button', { name: 'Fused' })).toHaveClass(/ja-platform-btn--active/);

    await extPage.getByPlaceholder('e.g. sindresorhus').fill('fused-user');
    await extPage.getByRole('button', { name: 'Load verified profile' }).click();

    await extPage.locator('.ja-result').waitFor({ timeout: 5000 });
    expect((lastAnalyzeBody() as { platform?: string }).platform).toBe('all');
  });
});

test.describe('cached snapshot resolution by subject (#55)', () => {
  test('loads an existing complete snapshot via by-subject without POST /analyze', async ({
    extPage,
    openPanel,
    lastAnalyzeBody,
  }) => {
    // 在用例级覆盖 fixture 的 by-subject 404：已有 complete 快照，只回 profileId 指针。
    // Playwright 后注册的路由先匹配并 fulfill，不会落到 fixture 的 404。
    await extPage.context().route('**/profiles/by-subject/**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          profileId: FIXTURE_PROFILE_ID,
          status: 'complete',
          cached: true,
        }),
      }),
    );

    await openPanel();
    await extPage.getByPlaceholder('e.g. sindresorhus').fill('cached-user');
    await extPage.getByRole('button', { name: 'Load verified profile' }).click();

    await extPage.locator('.ja-result').waitFor({ timeout: 5000 });

    // 命中已有快照：不得触发 POST /analyze（不扣演示配额、不受画像 24h 缓存 TTL 限制）。
    expect(lastAnalyzeBody()).toBeNull();

    // exportable 画像与岗位匹配链路仍正常加载。
    await expect(extPage.locator('.ja-match-list .ja-match-item')).toHaveCount(3);
  });
});
