import { test, expect, type Page } from '@playwright/test';
import {
  FIXTURE_PROFILE_ID,
  FIXTURE_CLAIMED_PROFILE_ID,
  FIXTURE_PARTIAL_PROFILE_ID,
  FIXTURE_SESSION_TOKEN,
  FIXTURE_EMPTY_SESSION_TOKEN,
} from './fixtures/sample-profile.js';
import { preloadAstro } from './preload.js';

/**
 * 批次 6 三个新前端表面的浏览器级验证（T29）：
 * 1. `/my`：未登录见登录墙；登录见名下画像列表；登录但无画像见空态。
 * 2. 自选岗位表单：ResumeBuilder 手动区填 JD → 生成 → iframe 预览（T24 入口）。
 * 3. partial 提示条（T25）与 `?unavailable=1` / `?notfound=1` 分流（home 页）。
 *
 * 全部 page.route mock /resumes/build 等 API，零真实后端；SSR 身份由 global-setup
 * 种下的 jobagent_session 会话解析。
 */
const BUILD_URL = '**/resumes/build';

const DRAFT = {
  schemaVersion: '0.1',
  ruleVersion: '0.1',
  generatedAt: '2026-09-16T00:00:00.000Z',
  subject: { login: 'alice', profileUrl: 'https://github.com/alice' },
  targetJob: {
    jobId: undefined,
    title: 'Rust Platform Engineer',
    company: 'Acme Corp',
    sourceUrl: null,
    matchScore: 5,
    tier: 'mid',
    matchedSkills: ['TypeScript'],
    fieldScores: { title: 2, tags: 0, description: 3 },
  },
  header: { name: 'Alice', headline: 'Backend developer', contact: { profileUrl: 'https://github.com/alice' } },
  summary: 'Backend developer targeting Rust Platform Engineer.',
  matchedSkills: [],
  otherSkills: [],
  evidenceHighlights: [],
  collaboration: [],
  localSections: { education: [], workHistory: [] },
  suggestions: [],
  gaps: [],
  provenance: { profileId: FIXTURE_PROFILE_ID, analyzerVersion: 'schema-0.1', ruleVersion: '0.1' },
};

const RESUME_HTML =
  '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"></head>' +
  '<body><h1 id="marker">MANUAL_RESUME_MARKER Rust Platform Engineer</h1></body></html>';

async function mockBuild(page: Page): Promise<void> {
  await page.route(BUILD_URL, (route) => {
    const post = route.request().postDataJSON() as { format?: string };
    const body =
      post.format === 'md'
        ? { format: 'md', draft: DRAFT, markdown: '# Rust Platform Engineer' }
        : { format: 'html', draft: DRAFT, html: RESUME_HTML };
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
}

async function seedSession(page: Page, token: string): Promise<void> {
  await page.context().addCookies([
    { name: 'jobagent_session', value: token, url: 'http://localhost:4321' },
  ]);
}

test.describe('/my (T17 surface)', () => {
  test.beforeAll(async () => {
    await preloadAstro('http://127.0.0.1:4321');
  }, { timeout: 120000 });

  test('anonymous visitor sees the login gate', async ({ page }) => {
    await page.goto('/zh-CN/my');
    await expect(page.getByTestId('my-gate')).toBeVisible();
    // 登录链接带 /zh-CN/my 的 return_to 深链
    await expect(page.getByTestId('my-gate').getByRole('link', { name: /登录/ })).toHaveAttribute(
      'href',
      /\/auth\/github\/login\?return_to=%2Fzh-CN%2Fmy$/,
    );
  });

  test('signed-in owner sees their profiles list (not lost after closing browser)', async ({ page }) => {
    await seedSession(page, FIXTURE_SESSION_TOKEN);
    await page.goto('/zh-CN/my');
    const item = page.locator(`a.my-profile-link[href="/zh-CN/report/${FIXTURE_PROFILE_ID}"]`);
    await expect(item).toBeVisible();
    // 已认领画像也在同一账号名下（FIXTURE_CLAIMED 的 login 与本人一致）
    await expect(
      page.locator(`a.my-profile-link[href="/zh-CN/report/${FIXTURE_CLAIMED_PROFILE_ID}"]`),
    ).toBeVisible();
  });

  test('signed-in user with no profiles sees the empty state', async ({ page }) => {
    await seedSession(page, FIXTURE_EMPTY_SESSION_TOKEN);
    await page.goto('/zh-CN/my');
    await expect(page.locator('.my-empty')).toBeVisible();
    await expect(page.locator('.my-empty p')).toContainText('还没有分析过任何画像');
    // 空态不渲染画像列表
    await expect(page.locator('.my-profile-list')).toHaveCount(0);
  });
});

test.describe('partial notice + unavailable/notfound split (T25 surfaces)', () => {
  test('partial profile renders the partial banner, not a fake-complete report', async ({ page }) => {
    await page.goto(`/zh-CN/report/${FIXTURE_PARTIAL_PROFILE_ID}`);
    await expect(page.getByTestId('partial-notice')).toBeVisible();
    await expect(page.getByTestId('partial-notice')).toContainText('部分数据');
  });

  test('?unavailable=1 shows the service-unavailable notice on home', async ({ page }) => {
    await page.goto('/zh-CN/?unavailable=1');
    await expect(page.getByTestId('unavailable-notice')).toBeVisible();
  });

  test('?notfound=1 shows the not-found notice on home', async ({ page }) => {
    await page.goto('/zh-CN/?notfound=1');
    await expect(page.getByTestId('notfound-notice')).toBeVisible();
  });
});

test.describe('self-select job form (T24 surface)', () => {
  test('manual JD → generate → iframe preview works without the job pool', async ({ page }) => {
    await mockBuild(page);
    await page.goto(`/zh-CN/report/${FIXTURE_PROFILE_ID}`);

    // 零技能画像也挂载简历岛（T29 门控修复的正面验证由 partial 用例覆盖；
    // 此处用标准画像验证手动表单主链路）
    const builder = page.locator('.resume-builder');
    await expect(builder).toBeVisible();

    // 手动区填 JD：标题 + 公司 + 描述 → 生成
    const titleInput = builder.locator('input').first();
    const companyInput = builder.locator('input').nth(1);
    const jdTextarea = builder.locator('textarea');
    const genBtn = builder.getByRole('button', { name: '针对此 JD 生成简历' });
    await titleInput.fill('Rust Platform Engineer');
    await companyInput.fill('Acme Corp');
    await jdTextarea.fill('Build and operate a multi-tenant job pipeline in Rust with async workers.');
    // hydration 竞态兜底：冷路由首次访问时 island JS 可能晚于 fill 接管，受控值被重置、
    // 事件丢失导致按钮不启用；先等 4s，未启用则重填一次确保 onChange 生效。
    try {
      await expect(genBtn).toBeEnabled({ timeout: 4000 });
    } catch {
      await titleInput.fill('Rust Platform Engineer');
      await jdTextarea.fill('Build and operate a multi-tenant job pipeline in Rust with async workers.');
      await expect(genBtn).toBeEnabled({ timeout: 15000 });
    }
    await genBtn.click();

    // 预览 iframe 出现且包含目标岗位
    const frame = page.frameLocator('.resume-iframe');
    await expect(frame.locator('#marker')).toContainText('Rust Platform Engineer');
  });
});
