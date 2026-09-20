import { test, expect } from '@playwright/test';
import { FIXTURE_PROFILE_ID, FIXTURE_SESSION_TOKEN } from './fixtures/sample-profile.js';

/**
 * 授权分级闸 E2E（2026-09-19）：
 * - 未登录（anonymous/demo）：报告页公开门面可见，但完整证据外链、面试题、面试准备包
 *   折叠为登录墙（GateCard），interview-kit.md 端点 401。
 * - 已登录 user（jobagent_session 有效会话）：全部解锁，interview-kit.md 200。
 * 身份完全由 SSR 读 Cookie + 只读 storage 决定，不依赖客户端 /auth/me。
 */

const profilePath = `/en/report/${FIXTURE_PROFILE_ID}`;
const QUESTION_TEXT = 'Walk through your most complex external PR.';

test.describe('gated content for anonymous visitors', () => {
  test('candidate view hides interview questions behind a sign-in gate', async ({ page }) => {
    await page.goto(profilePath);

    const gate = page.getByTestId('interview-gate');
    await expect(gate).toBeVisible();
    // 墙文案带题数（fixture 1 题）
    await expect(gate).toContainText('1');
    // 登录按钮携带当前页 return_to 深链
    await expect(gate.getByTestId('gate-login')).toHaveAttribute(
      'href',
      /\/auth\/github\/login\?return_to=/,
    );

    // 题目正文与面试包下载链接不渲染
    expect(await page.locator('.question').count()).toBe(0);
    expect(await page.locator('.interview-kit-link').count()).toBe(0);
  });

  test('recruiter view hides evidence links behind a sign-in gate', async ({ page }) => {
    await page.goto(`${profilePath}?view=recruiter`);

    await expect(page.getByTestId('evidence-gate')).toBeVisible();
    // 未登录不渲染招聘方说明 banner（位置让给登录墙）
    expect(await page.locator('.recruiter-banner').count()).toBe(0);
    // 任何可点击原始证据外链都不出现
    expect(await page.locator('.evidence-links a').count()).toBe(0);
  });

  test('interview kit download returns 401 without a session', async ({ page }) => {
    const res = await page.request.get(`${profilePath}/interview-kit.md`);
    expect(res.status()).toBe(401);
  });
});

test.describe('gated content unlocked for signed-in users', () => {
  test.beforeEach(async ({ context }) => {
    await context.addCookies([
      { name: 'jobagent_session', value: FIXTURE_SESSION_TOKEN, domain: 'localhost', path: '/' },
    ]);
  });

  test('candidate view shows interview questions and the kit download', async ({ page }) => {
    await page.goto(profilePath);

    expect(await page.getByTestId('interview-gate').count()).toBe(0);
    await expect(page.locator('.question').first()).toContainText(QUESTION_TEXT);
    expect(await page.locator('.interview-kit-link').count()).toBe(1);
  });

  test('recruiter view shows evidence links and the recruiter banner', async ({ page }) => {
    await page.goto(`${profilePath}?view=recruiter`);

    expect(await page.getByTestId('evidence-gate').count()).toBe(0);
    expect(await page.locator('.recruiter-banner').count()).toBe(1);
    // 外部 PR 证据外链可点击，指向 fixture 固定 URL
    const evidenceLink = page.locator('.evidence-links a').first();
    await expect(evidenceLink).toHaveAttribute(
      'href',
      'https://github.com/e2e-fixture-user/core/pull/42',
    );
  });

  test('interview kit download returns 200 with a session', async ({ page }) => {
    const res = await page.request.get(`${profilePath}/interview-kit.md`);
    expect(res.status()).toBe(200);
  });
});
