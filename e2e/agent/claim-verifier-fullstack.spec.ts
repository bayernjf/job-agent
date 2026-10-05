/**
 * 简历声明核验（决策 #23 批次 2）—— 真全栈 E2E。
 *
 * 组件有 jsdom 表面测试、HTTP 有真 SQLite 集成测试，这条补的是两者之间的缝：
 * 真 Chromium → 真报告页 SSR/React island → 真 API（3101）→ 真 SQLite，验证
 * "贴声明 → 后端判定 → 徽章/证据链接渲染 → 撤回落库"在真链路上走得通，也验证
 * 未登录访客根本看不到这个表面（401 fail-closed 收起）。
 *
 * 两种身份各覆盖一态（夹具画像已被本人认领，技能 TypeScript 有 ev-a/ev-b 两条证据）：
 *   - 本人（求职者自检视图）：supportable，证据可点
 *   - 已声明招聘方（B 端视图，login 与主体不同）：insufficient_data
 * 不 mock 任何端点。
 */
import { test, expect, type Page } from '@playwright/test';
import { FIXTURE_PROFILE_ID, default as resetAgentFixtures } from './global-setup';
import { API, authHeaders, login, loginAsRecruiter, recruiterAuthHeaders } from './helpers';

const REPORT_CANDIDATE = `/en/report/${FIXTURE_PROFILE_ID}?view=recruiter`;
const REPORT_SELF = `/en/report/${FIXTURE_PROFILE_ID}`;

interface ClaimView {
  id: string;
  verdict: string;
  claimText: string;
  matchedEvidence: { id: string; url: string; claim: string }[];
}

async function listClaims(page: Page, headers: { Cookie: string }): Promise<ClaimView[]> {
  const res = await page.request.get(
    `${API}/profiles/${FIXTURE_PROFILE_ID}/claim-verifications`,
    { headers },
  );
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { items: ClaimView[] };
  return body.items;
}

test.describe('claim verifier — full stack', () => {
  test.beforeEach(async () => {
    await resetAgentFixtures();
  });

  test('candidate owner self-checks a supportable claim with clickable evidence', async ({
    page,
  }) => {
    await login(page);

    // 起点：库里没有任何核验记录，确保后面看到的是本用例真建出来的
    expect(await listClaims(page, authHeaders)).toHaveLength(0);

    const post = page.waitForResponse(
      (r) => r.url().includes('/claim-verifications') && r.request().method() === 'POST',
    );
    await page.goto(REPORT_SELF);
    const verifier = page.getByTestId('claim-verifier');
    await expect(verifier).toBeVisible();
    await expect(verifier).toHaveAttribute('data-hydrated', 'true');
    await expect(verifier).toContainText('Pre-application self-check');

    await page.getByTestId('claim-input').fill('Built services in TypeScript');
    await verifier.getByRole('button', { name: 'Verify claim' }).click();
    const res = await post;
    expect(res.status()).toBe(201);
    const created = (await res.json()) as ClaimView;
    expect(created.verdict).toBe('supportable');
    expect(created.matchedEvidence).toHaveLength(2);

    // 徽章按 verdict code 渲染，证据链接真的指向原始行为记录
    await expect(verifier.locator('.claim-verdict--supportable')).toBeVisible();
    const evidenceLink = verifier.getByRole('link', { name: /Merged PR #42|Committed/ });
    await expect(evidenceLink.first()).toBeVisible();
    await expect(evidenceLink.first()).toHaveAttribute(
      'href',
      /^https:\/\/github\.com\/agent-e2e\//,
    );

    // 落库口径与页面一致（真读 GET，不只信 POST 回包）
    const stored = await listClaims(page, authHeaders);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.verdict).toBe('supportable');
  });

  test('declared recruiter verifies an abstract claim as insufficient_data', async ({ page }) => {
    await loginAsRecruiter(page);

    const post = page.waitForResponse(
      (r) => r.url().includes('/claim-verifications') && r.request().method() === 'POST',
    );
    await page.goto(REPORT_CANDIDATE);
    const verifier = page.getByTestId('claim-verifier');
    await expect(verifier).toBeVisible();
    await expect(verifier).toHaveAttribute('data-hydrated', 'true');
    await expect(verifier).toContainText('Resume claim verification');

    await page.getByTestId('claim-input').fill('Excellent communication skills');
    await verifier.getByRole('button', { name: 'Verify claim' }).click();
    const res = await post;
    expect(res.status()).toBe(201);
    const created = (await res.json()) as ClaimView;
    // 抽不出可核验 token ≠ "没做过"：必须是 insufficient_data，且不挂证据
    expect(created.verdict).toBe('insufficient_data');
    expect(created.matchedEvidence).toHaveLength(0);
    await expect(verifier.locator('.claim-verdict--insufficient_data')).toBeVisible();
    await expect(verifier.locator('.claim-verdict--no_trace')).toHaveCount(0);
  });

  test('withdraw removes a claim the creator made', async ({ page }) => {
    await loginAsRecruiter(page);
    await page.goto(REPORT_CANDIDATE);
    const verifier = page.getByTestId('claim-verifier');
    await expect(verifier).toBeVisible();
    await expect(verifier).toHaveAttribute('data-hydrated', 'true');

    await page.getByTestId('claim-input').fill('Excellent communication skills');
    await verifier.getByRole('button', { name: 'Verify claim' }).click();
    await expect(verifier.locator('.claim-verification')).toHaveCount(1);

    const del = page.waitForResponse(
      (r) => r.url().includes('/claim-verifications/') && r.request().method() === 'DELETE',
    );
    await verifier.getByRole('button', { name: 'Withdraw' }).click();
    expect((await del).status()).toBe(200);
    await expect(verifier.locator('.claim-verification')).toHaveCount(0);
    expect(await listClaims(page, recruiterAuthHeaders)).toHaveLength(0);
  });

  test('anonymous visitor does not see the verifier surface at all', async ({ page }) => {
    // 未登录：招聘方视图挂载的 island 会在 GET 401 后 fail-closed 整体收起
    await page.goto(REPORT_CANDIDATE);
    await expect(page.getByTestId('claim-verifier')).toHaveCount(0);

    const res = await page.request.get(
      `${API}/profiles/${FIXTURE_PROFILE_ID}/claim-verifications`,
    );
    expect(res.status()).toBe(401);
  });
});
