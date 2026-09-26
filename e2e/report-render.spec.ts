import { test, expect } from '@playwright/test';
import { composeImprovementSuggestion } from '@jobagent/shared';
import {
  FIXTURE_GITEE_PROFILE_ID,
  FIXTURE_PROFILE_ID,
  FIXTURE_FUSED_PROFILE_ID,
  FIXTURE_NEXT_STEPS_PROFILE_ID,
  FIXTURE_SESSION_TOKEN,
  FIXTURE_LOGIN,
} from './fixtures/sample-profile.js';

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

    // 概述 headline 按读者语言现拼（T07），不再是快照里的英文原文
    await expect(page.locator('.headline')).toHaveText(
      'TypeScript developer with 24 months of GitHub activity',
    );

    // 能力标签（.skill-tag 内还含深度子标签，故用 hasText 而非精确文本）
    await expect(page.locator('.skill-tag', { hasText: 'TypeScript' })).toBeVisible();
    await expect(page.locator('.skill-tag', { hasText: 'React' })).toBeVisible();

    // 真实性信号
    await expect(page.getByText('External PRs merged')).toBeVisible();

    // 外部协作
    await expect(page.getByText('octo/awesome-lib#12')).toBeVisible();

    // 面试题：授权分级闸后，未登录折叠为登录墙（题目正文登录后可见，见 gated-content.spec）
    await expect(page.getByTestId('interview-gate')).toBeVisible();
    expect(await page.getByText('Walk through your most complex external PR.').count()).toBe(0);

    // 盲区
    await expect(page.getByText(/Private contribution graph/)).toBeVisible();

    // 异议入口：mailto 始终渲染，主题带画像 id
    const dispute = page.locator('.caveats .dispute a');
    await expect(dispute).toBeVisible();
    await expect(dispute).toHaveAttribute('href', /^mailto:dispute@job-agent\.bayjf\.com\?subject=.*profe2efixture/);
  });

  test('renders the same fixture under Chinese route', async ({ page }) => {
    await page.goto(`/zh-CN/report/${FIXTURE_PROFILE_ID}`);
    await expect(page).toHaveURL(new RegExp(`/zh-CN/report/${FIXTURE_PROFILE_ID}`));
    await expect(page.locator('h1.login')).toContainText('E2E Fixture User');
    await expect(page.locator('.skill-tag', { hasText: 'TypeScript' })).toBeVisible();
    // 同一份快照，中文读者看到中文一句话定位（T07）
    await expect(page.locator('.headline')).toHaveText(
      'TypeScript 开发者，在 GitHub 持续活跃 24 个月',
    );
  });

  test('names Gitee, never GitHub, on a Gitee-subject profile (T07)', async ({ page }) => {
    await page.goto(`/en/report/${FIXTURE_GITEE_PROFILE_ID}`);
    await expect(page.locator('.headline')).toHaveText(
      'TypeScript developer with 24 months of Gitee activity',
    );
  });

  test('redirects to home with notfound for an unknown profile', async ({ page }) => {
    await page.goto('/en/report/prof-does-not-exist-xyz');
    await page.waitForURL(/\/en\/\?notfound=1/, { timeout: 10000 });
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  });

  test('does not show the fused badge on a single-source profile', async ({ page }) => {
    await page.goto(`/en/report/${FIXTURE_PROFILE_ID}`);
    await expect(page.locator('.ja-badge--fused')).toHaveCount(0);
    await expect(page.getByTestId('fusion-stats')).toHaveCount(0);
  });

  test('shows the GitHub+Gitee fused badge on the all-platform profile (English)', async ({ page }) => {
    await page.goto(`/en/report/${FIXTURE_FUSED_PROFILE_ID}`);
    const badge = page.locator('.profile-header .ja-badge--fused');
    await expect(badge).toBeVisible();
    await expect(badge).toContainText('GitHub + Gitee fused');
    // 融合去重统计行：镜像合并 + commit/PR/issue 去重四项（fixture 均非 0）
    const stats = page.getByTestId('fusion-stats');
    await expect(stats).toBeVisible();
    await expect(stats.locator('.ja-fusion-stat')).toHaveCount(4);
    await expect(stats).toContainText('mirror repos merged');
    await expect(stats).toContainText('duplicate commits removed');
    await expect(stats).toContainText('duplicate PRs removed');
    await expect(stats).toContainText('duplicate issues removed');
  });

  test('shows the fused badge in Chinese under the zh-CN route', async ({ page }) => {
    await page.goto(`/zh-CN/report/${FIXTURE_FUSED_PROFILE_ID}`);
    const badge = page.locator('.profile-header .ja-badge--fused');
    await expect(badge).toBeVisible();
    await expect(badge).toContainText('双源融合');
    await expect(page.getByTestId('fusion-stats')).toContainText('条重复提交已去重');
  });
});

/**
 * 下一步动作区块（T10）：`improvementSuggestions` 快照只存数据层英文原文，
 * 页面按读者语言由 shared 的模板现拼；证据外链仍受授权分级闸约束；招聘方视图不显示。
 */
const nextStepsPath = `/en/report/${FIXTURE_NEXT_STEPS_PROFILE_ID}`;
const EN_COPY = composeImprovementSuggestion('no_pull_requests', 'en');
const ZH_COPY = composeImprovementSuggestion('no_pull_requests', 'zh-CN');

test.describe('next steps suggestions', () => {
  test('renders the English copy for an English reader', async ({ page }) => {
    await page.goto(nextStepsPath);
    const section = page.getByTestId('next-steps');
    await expect(section).toBeVisible();
    await expect(section.locator('h2')).toHaveText('Next steps');
    await expect(section.locator('.next-step-action')).toHaveText(EN_COPY.suggestion);
    await expect(section.locator('.next-step-why')).toContainText(EN_COPY.why);
    // 未登录：只报条数，不给证据外链
    await expect(section).toContainText('1 related evidence');
    expect(await section.locator('.next-step-evidence a').count()).toBe(0);
  });

  test('renders Chinese copy, not the stored English sentence, under zh-CN', async ({ page }) => {
    await page.goto(`/zh-CN/report/${FIXTURE_NEXT_STEPS_PROFILE_ID}`);
    const section = page.getByTestId('next-steps');
    await expect(section).toBeVisible();
    await expect(section.locator('h2')).toHaveText('下一步动作');
    await expect(section.locator('.next-step-action')).toHaveText(ZH_COPY.suggestion);
    expect(await page.getByText(EN_COPY.suggestion).count()).toBe(0);
  });

  test('unlocks the evidence link once signed in', async ({ page, context }) => {
    await context.addCookies([
      { name: 'jobagent_session', value: FIXTURE_SESSION_TOKEN, domain: 'localhost', path: '/' },
    ]);
    await page.goto(nextStepsPath);
    const link = page.locator('.next-step-evidence a');
    await expect(link).toHaveCount(1);
    await expect(link).toHaveAttribute('href', /github\.com\/e2e-next-steps-user/);
  });

  test('is absent from the recruiter view', async ({ page }) => {
    await page.goto(`${nextStepsPath}?view=recruiter`);
    expect(await page.getByTestId('next-steps').count()).toBe(0);
  });
});
