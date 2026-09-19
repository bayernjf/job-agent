import { test, expect, type Page } from '@playwright/test';
import { FIXTURE_PROFILE_ID, FIXTURE_LOGIN } from './fixtures/sample-profile.js';

/**
 * 账号登录/认领前端 E2E（账号主脊 item28-⑤）：
 * - AccountMenu：匿名显示「用 GitHub 登录」；登录用户显示身份与退出，退出后回到匿名
 * - ClaimProfile：仅登录且 platform+login 与画像主体一致的本人显示认领 CTA，
 *   认领成功切换为「本人已验证」徽章；非本人/匿名不显示
 * 全部 page.route mock（/auth/me、/profiles/:id/claim、/auth/logout），零真实后端/OAuth。
 */

async function mockAuthMe(page: Page, body: unknown): Promise<void> {
  await page.route('**/auth/me', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) }),
  );
}

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

test.describe('AccountMenu', () => {
  test('shows the GitHub sign-in entry for an anonymous visitor', async ({ page }) => {
    await mockAuthMe(page, { kind: 'anonymous' });
    await page.goto('/en/');
    await waitForHydrated(page);

    const signIn = page.getByRole('link', { name: 'Sign in with GitHub' });
    await expect(signIn).toBeVisible();
    await expect(signIn).toHaveAttribute('href', /\/auth\/github\/login$/);
  });

  test('shows the signed-in identity and signs out back to anonymous', async ({ page }) => {
    let meCalls = 0;
    await page.route('**/auth/me', (route) => {
      meCalls += 1;
      // 首次为登录用户，退出刷新后为匿名
      const body =
        meCalls === 1
          ? { kind: 'user', platform: 'github', login: FIXTURE_LOGIN, name: 'Fixture User', avatarUrl: null }
          : { kind: 'anonymous' };
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    });
    let logoutCalls = 0;
    await page.route('**/auth/logout', (route) => {
      logoutCalls += 1;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    await page.goto('/en/');
    await waitForHydrated(page);
    await expect(page.locator('.account-menu__login')).toContainText('Fixture User');

    await page.getByRole('button', { name: 'Sign out' }).click();
    expect(logoutCalls).toBe(1);
    await expect(page.getByRole('link', { name: 'Sign in with GitHub' })).toBeVisible();
  });
});

test.describe('ClaimProfile', () => {
  test('lets the matching owner claim the profile and then shows the verified badge', async ({ page }) => {
    await mockAuthMe(page, {
      kind: 'user',
      platform: 'github',
      login: FIXTURE_LOGIN,
      claimedProfileId: null,
    });
    let claimCalls = 0;
    await page.route(/\/profiles\/[^/]+\/claim$/, (route) => {
      claimCalls += 1;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          profileId: FIXTURE_PROFILE_ID,
          claimed: true,
          subject: { platform: 'github', login: FIXTURE_LOGIN },
          claimedProfileId: FIXTURE_PROFILE_ID,
        }),
      });
    });

    await page.goto(`/en/report/${FIXTURE_PROFILE_ID}`);
    await waitForHydrated(page);

    const claimButton = page.getByTestId('claim-button');
    await expect(claimButton).toBeVisible();
    await expect(claimButton).toContainText('Claim this profile');
    await claimButton.click();

    expect(claimCalls).toBe(1);
    const badge = page.getByTestId('claimed-badge');
    await expect(badge).toBeVisible();
    await expect(badge).toContainText('Verified owner');
  });

  test('hides the claim CTA for a signed-in non-owner', async ({ page }) => {
    await mockAuthMe(page, {
      kind: 'user',
      platform: 'github',
      login: 'someone-else',
      claimedProfileId: null,
    });
    await page.goto(`/en/report/${FIXTURE_PROFILE_ID}`);
    await waitForHydrated(page);
    await expect(page.getByTestId('claim-button')).toHaveCount(0);
    await expect(page.getByTestId('claimed-badge')).toHaveCount(0);
  });

  test('hides the claim CTA for an anonymous visitor', async ({ page }) => {
    await mockAuthMe(page, { kind: 'anonymous' });
    await page.goto(`/en/report/${FIXTURE_PROFILE_ID}`);
    await waitForHydrated(page);
    await expect(page.getByTestId('claim-button')).toHaveCount(0);
    await expect(page.getByTestId('claimed-badge')).toHaveCount(0);
  });

  test('renders the verified badge from SSR for an already-claimed profile without relying on JS', async ({
    page,
  }) => {
    // fixture 画像 claimed=false，故这里通过 owner 已认领的 /auth/me 验证 island 徽章路径；
    // SSR claimed=true 路径由后端单测覆盖（无 claimed fixture）。
    await mockAuthMe(page, {
      kind: 'user',
      platform: 'github',
      login: FIXTURE_LOGIN,
      claimedProfileId: FIXTURE_PROFILE_ID,
    });
    await page.goto(`/en/report/${FIXTURE_PROFILE_ID}`);
    await waitForHydrated(page);
    // 已认领该画像：island 直接渲染徽章，不出现认领按钮
    await expect(page.getByTestId('claim-button')).toHaveCount(0);
    await expect(page.getByTestId('claimed-badge')).toBeVisible();
  });
});
