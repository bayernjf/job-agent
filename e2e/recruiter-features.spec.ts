import { test, expect, type Page } from '@playwright/test';
import { FIXTURE_PROFILE_ID, FIXTURE_SESSION_TOKEN } from './fixtures/sample-profile.js';

/**
 * 痛点解决方案批次 2 的报告页 E2E：
 * - 招聘方核验视图（?view=recruiter）：banner 可见、可切回求职者视角、
 *   求职者专属模块（投递追踪、面试包下载、岗位推荐/简历生成）不渲染。
 * - 求职者视图：面试准备包下载链接、投递追踪 island（空态 + 新增后列表）。
 * - 人才库页 /[locale]/recruit：SSR 直接从 fixture DB 渲染候选人卡片。
 * 客户端接口（/api/.../applications）用 page.route mock，不依赖真实 API。
 */

const APPLICATIONS_COLLECTION_URL = '**/profiles/*/applications**';

interface MockApplication {
  id: string;
  profileId: string;
  targetTitle: string;
  targetCompany: string;
  targetUrl: string | null;
  jobId: string | null;
  source: string | null;
  status: string;
  origin: string;
  note: string | null;
  appliedAt: string;
  createdAt: string;
  updatedAt: string;
}

test.describe('recruiter verification view', () => {
  // 授权分级闸后，招聘方证据 banner 与面试包下载仅登录 user 可见：本 describe 统一登录态。
  test.beforeEach(async ({ context }) => {
    await context.addCookies([
      { name: 'jobagent_session', value: FIXTURE_SESSION_TOKEN, domain: 'localhost', path: '/' },
    ]);
  });

  test('shows recruiter banner and hides candidate-only modules', async ({ page }) => {
    await page.goto(`/en/report/${FIXTURE_PROFILE_ID}?view=recruiter`);

    // 招聘方视角 banner + 视角切换链接
    await expect(page.locator('.recruiter-banner')).toContainText('Recruiter verification view');
    const backLink = page.locator('.view-toggle');
    await expect(backLink).toContainText('Back to candidate view');
    await expect(backLink).toHaveAttribute(
      'href',
      `/en/report/${FIXTURE_PROFILE_ID}`,
    );

    // 求职者专属：投递追踪 island 不挂载、面试包下载不出现
    await expect(page.locator('.apptrk')).toHaveCount(0);
    await expect(page.locator('.interview-kit-link')).toHaveCount(0);
    // 岗位推荐 / 简历生成在招聘方视角隐藏
    await expect(page.locator('.job-recs')).toHaveCount(0);
    await expect(page.locator('.resume-builder')).toHaveCount(0);
  });

  test('candidate view exposes the recruiter entry and interview kit download', async ({ page }) => {
    await mockEmptyApplications(page);
    await page.goto(`/en/report/${FIXTURE_PROFILE_ID}`);

    const recruiterEntry = page.locator('.view-toggle');
    await expect(recruiterEntry).toContainText('View as recruiter (verify evidence)');
    await expect(recruiterEntry).toHaveAttribute(
      'href',
      `/en/report/${FIXTURE_PROFILE_ID}?view=recruiter`,
    );

    // 面试准备包下载（fixture 画像有面试题，区块渲染）
    const kit = page.locator('.interview-kit-link');
    await expect(kit).toHaveCount(1);
    await expect(kit).toHaveAttribute(
      'href',
      `/en/report/${FIXTURE_PROFILE_ID}/interview-kit.md`,
    );
  });
});

test.describe('application tracker', () => {
  test('renders empty state and adds an application through the form', async ({ page }) => {
    const store: MockApplication[] = [];
    await page.route(APPLICATIONS_COLLECTION_URL, async (route) => {
      const request = route.request();
      if (request.method() === 'POST') {
        const body = (request.postDataJSON() ?? {}) as Partial<MockApplication>;
        const now = '2026-09-16T00:00:00.000Z';
        const record: MockApplication = {
          id: 'app-e2e-1',
          profileId: FIXTURE_PROFILE_ID,
          targetTitle: body.targetTitle ?? '',
          targetCompany: body.targetCompany ?? '',
          targetUrl: body.targetUrl ?? null,
          jobId: null,
          source: body.source ?? null,
          status: 'applied',
          origin: 'manual',
          note: null,
          appliedAt: now,
          createdAt: now,
          updatedAt: now,
        };
        store.push(record);
        return route.fulfill({ status: 201, json: record });
      }
      return route.fulfill({ status: 200, json: { items: store } });
    });

    await page.goto(`/en/report/${FIXTURE_PROFILE_ID}`);

    const tracker = page.locator('.apptrk');
    await expect(tracker).toContainText('Application tracker');
    await expect(tracker).toContainText('No applications yet');

    // 展开新增表单，填写一条投递
    await tracker.getByRole('button', { name: /add application/i }).click();
    await tracker.locator('#apptrk-company').fill('Acme');
    await tracker.locator('#apptrk-role').fill('Senior Engineer');
    await tracker.locator('button[type="submit"]').first().click();

    // 提交后 reload，列表出现新记录
    await expect(tracker.locator('.apptrk-item-title')).toContainText('Senior Engineer');
    await expect(tracker.locator('.apptrk-item-title')).toContainText('Acme');
  });
});

test.describe('candidate search page', () => {
  test('renders fixture candidates from SSR data and a fused badge for the all-platform profile', async ({
    page,
  }) => {
    await page.goto('/en/recruit');
    const cards = page.locator('.recruit-grid .recruit-card');
    await expect(cards).toHaveCount(2);

    // 普通 GitHub 画像卡：裸显平台 github，核验链接指向其 profileId
    const githubCard = cards.filter({ hasText: 'e2e-fixture-user' });
    await expect(githubCard).toHaveCount(1);
    await expect(githubCard.locator('.recruit-login')).toContainText('github');
    await expect(githubCard.locator('.recruit-view')).toHaveAttribute(
      'href',
      new RegExp(`/en/report/${FIXTURE_PROFILE_ID}\\?view=recruiter`),
    );

    // 融合画像卡：不裸显内部检索键 all，而是双源融合徽标
    const fusedCard = cards.filter({ hasText: 'e2e-fused-user' });
    await expect(fusedCard).toHaveCount(1);
    await expect(fusedCard.locator('.ja-badge--fused')).toBeVisible();
    await expect(fusedCard.locator('.ja-badge--fused')).toContainText('GitHub + Gitee fused');
    await expect(fusedCard.locator('.recruit-login')).not.toContainText(' all');
  });
});

function mockEmptyApplications(page: Page): Promise<void> {
  return page.route(APPLICATIONS_COLLECTION_URL, (route) =>
    route.fulfill({ status: 200, json: { items: [] } }),
  );
}
