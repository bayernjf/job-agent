import { test, expect, type Page, type Locator } from '@playwright/test';
import { FIXTURE_PROFILE_ID } from './fixtures/sample-profile.js';

/**
 * 报告页「为你推荐的岗位」island E2E（第一档匹配接线②）。
 *
 * island 在浏览器 mount 后请求同源 GET /profiles/:id/job-recommendations，
 * 这里用 page.route mock 该接口，覆盖 列表 / 空 / 错误 三态与中文标题，
 * 不依赖真实 API/岗位库，保证确定性（与 home-flow.spec.ts 同一手法）。
 *
 * 断言一律 scope 到 .job-recs section：Astro Dev Toolbar 的 island inspector
 * 会在 shadow DOM 以 <code> 渲染 props（含 i18n 文案），全局文本定位会误匹配。
 */

const RECOMMENDATIONS_URL = '**/profiles/*/job-recommendations**';

function mockRecommendations(page: Page, body: unknown, status = 200): Promise<void> {
  return page.route(RECOMMENDATIONS_URL, (route) =>
    route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify(body),
    }),
  );
}

const TWO_MATCHES = {
  profileId: FIXTURE_PROFILE_ID,
  profileSkills: ['TypeScript', 'React'],
  total: 2,
  candidatePool: 120,
  matches: [
    {
      score: 9,
      matchedSkills: ['TypeScript', 'React'],
      posting: {
        jobId: 'job-1',
        source: 'remoteok',
        sourceUrl: 'https://example.test/job-1',
        title: 'Senior TypeScript Engineer',
        company: 'Acme Corp',
        location: 'Remote',
        remote: true,
        postedAt: '2026-09-01T00:00:00.000Z',
      },
    },
    {
      score: 4,
      matchedSkills: ['React'],
      posting: {
        jobId: 'job-2',
        source: 'lever',
        sourceUrl: 'https://example.test/job-2',
        title: 'Frontend Developer',
        company: 'Beta Ltd',
        remote: false,
        postedAt: '2026-08-20T00:00:00.000Z',
      },
    },
  ],
};

test.describe('job recommendations island', () => {
  test('renders matched jobs with score, company and matched skills', async ({ page }) => {
    await mockRecommendations(page, TWO_MATCHES);
    await page.goto(`/en/report/${FIXTURE_PROFILE_ID}`);

    const section = page.locator('.job-recs');
    await expect(section.getByRole('heading', { name: 'Recommended jobs for you' })).toBeVisible();

    // 两条匹配都渲染
    const items = section.locator('.rec-item');
    await expect(items).toHaveCount(2);

    // 第一条岗位：标题链接、公司、匹配分、命中技能、远程标签
    const first = items.first();
    await expect(first.locator('.rec-title', { hasText: 'Senior TypeScript Engineer' })).toBeVisible();
    await expect(first).toContainText('Acme Corp');
    await expect(first.locator('.rec-score', { hasText: '9' })).toBeVisible();
    await expect(first.locator('.skill-tag', { hasText: 'TypeScript' })).toBeVisible();
    await expect(first.locator('.skill-tag', { hasText: 'React' })).toBeVisible();
    await expect(first.locator('.rec-badge', { hasText: 'Remote' })).toBeVisible();

    // 岗位链接指向 sourceUrl 且新窗口打开
    await expect(first.locator('.rec-title')).toHaveAttribute('href', 'https://example.test/job-1');
    await expect(first.locator('.rec-title')).toHaveAttribute('target', '_blank');

    // 第二条：仅命中 React、无远程标签
    const second = items.nth(1);
    await expect(second.locator('.skill-tag', { hasText: 'React' })).toBeVisible();
    await expect(second.locator('.rec-badge')).toHaveCount(0);
  });

  test('renders empty state when no jobs match', async ({ page }) => {
    await mockRecommendations(page, {
      profileId: FIXTURE_PROFILE_ID,
      profileSkills: [],
      matches: [],
    });
    await page.goto(`/en/report/${FIXTURE_PROFILE_ID}`);

    const section: Locator = page.locator('.job-recs');
    await expect(section.locator('.rec-status')).toContainText(/No matching jobs yet/);
    await expect(section.locator('.rec-item')).toHaveCount(0);
  });

  test('renders error state when the API fails', async ({ page }) => {
    await mockRecommendations(page, { error: 'boom' }, 500);
    await page.goto(`/en/report/${FIXTURE_PROFILE_ID}`);

    const section = page.locator('.job-recs');
    await expect(section.getByRole('alert')).toContainText('Failed to load recommendations');
    await expect(section.locator('.rec-item')).toHaveCount(0);
  });

  test('renders localized copy under Chinese route', async ({ page }) => {
    await mockRecommendations(page, TWO_MATCHES);
    await page.goto(`/zh-CN/report/${FIXTURE_PROFILE_ID}`);

    const section = page.locator('.job-recs');
    await expect(section.getByRole('heading', { name: '为你推荐的岗位' })).toBeVisible();
    // 中文路由下命中技能标签文案（第一条岗位）
    await expect(section.locator('.rec-skills-label').first()).toContainText('命中技能');
  });
});
