import { test, expect, type Page, type Request } from '@playwright/test';
import { FIXTURE_PROFILE_ID } from './fixtures/sample-profile.js';

/**
 * 岗位定向简历 E2E（P-R2）。
 *
 * 两个 island 经 DOM CustomEvent 解耦：岗位卡片（JobRecommendations）点击
 * 「Build a targeted resume」→ ResumeBuilder 调 POST /resumes/build → iframe 预览。
 * 与 job-recommendations.spec.ts 同一手法：page.route mock 两个接口，不起真实
 * API/Worker，保证确定性。断言 scope 到 .job-recs / .resume-builder，避免 Astro
 * toolbar（已 --no-toolbar）与全局文本误匹配。
 */

const RECOMMENDATIONS_URL = '**/profiles/*/job-recommendations**';
const BUILD_URL = '**/resumes/build';
const LOCAL_FIELDS_KEY = 'jobagent.localProfile';
const LEGACY_FIELDS_KEY = 'jobagent.localResumeFields';

const ONE_MATCH = {
  profileId: FIXTURE_PROFILE_ID,
  profileSkills: ['TypeScript'],
  matches: [
    {
      score: 7,
      matchedSkills: ['TypeScript'],
      fieldScores: { title: 3, tags: 2, description: 2 },
      posting: {
        id: 'job-internal-1', // 内部主键，简历端点用它（非外部 jobId）
        jobId: 'ext-1',
        source: 'remoteok',
        sourceUrl: 'https://example.test/job-1',
        title: 'Senior TypeScript Engineer',
        company: 'Acme Corp',
        remote: true,
        postedAt: '2026-09-01T00:00:00.000Z',
      },
    },
  ],
};

const DRAFT = {
  schemaVersion: '0.1',
  ruleVersion: '0.1',
  generatedAt: '2026-09-16T00:00:00.000Z',
  subject: { login: 'alice', profileUrl: 'https://github.com/alice' },
  targetJob: {
    jobId: 'ext-1',
    title: 'Senior TypeScript Engineer',
    company: 'Acme Corp',
    sourceUrl: 'https://example.test/job-1',
    matchScore: 7,
    tier: 'high',
    matchedSkills: ['TypeScript'],
    fieldScores: { title: 3, tags: 2, description: 2 },
  },
  header: { name: 'Alice', headline: 'Backend developer', contact: { profileUrl: 'https://github.com/alice' } },
  summary: 'Backend developer targeting Senior TypeScript Engineer.',
  matchedSkills: [],
  otherSkills: [],
  evidenceHighlights: [],
  collaboration: [],
  localSections: { education: [], workHistory: [] },
  suggestions: [{ kind: 'missing_field', text: 'Add your email' }],
  gaps: ['Email'],
  provenance: { profileId: FIXTURE_PROFILE_ID, analyzerVersion: 'schema-0.1', ruleVersion: '0.1' },
};

const RESUME_HTML =
  '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><style>@media print{body{color:#000}}</style></head>' +
  '<body><h1 id="marker">RESUME_MARKER Senior TypeScript Engineer</h1></body></html>';

async function mockRecommendations(page: Page): Promise<void> {
  await page.route(RECOMMENDATIONS_URL, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ONE_MATCH) }),
  );
}

/** mock /resumes/build；failOnce=true 时首次返回 500（用于重试用例）。 */
async function mockBuild(page: Page, buildRequests: unknown[], failOnce = false): Promise<void> {
  let calls = 0;
  await page.route(BUILD_URL, async (route) => {
    calls += 1;
    const post = route.request().postDataJSON() as Record<string, unknown>;
    buildRequests.push(post);
    if (failOnce && calls === 1) {
      return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'boom' }) });
    }
    const body =
      post.format === 'md'
        ? { format: 'md', draft: DRAFT, markdown: '# Senior TypeScript Engineer' }
        : { format: 'html', draft: DRAFT, html: RESUME_HTML };
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
}

test.describe('targeted resume builder', () => {
  test('builds an HTML resume from a job card and previews it in an iframe', async ({ page }) => {
    const requests: unknown[] = [];
    await mockRecommendations(page);
    await mockBuild(page, requests);
    await page.goto(`/en/report/${FIXTURE_PROFILE_ID}`);

    const card = page.locator('.job-recs .rec-item').first();
    const buildBtn = card.getByRole('button', { name: 'Build a targeted resume' });
    await expect(buildBtn).toBeVisible();
    await buildBtn.click();

    // 请求体：内部 jobId + locale + html，profileId 正确
    await expect.poll(() => requests.length).toBe(1);
    const first = requests[0] as Record<string, unknown>;
    expect(first).toMatchObject({
      profileId: FIXTURE_PROFILE_ID,
      jobId: 'job-internal-1',
      locale: 'en',
      format: 'html',
    });

    // 简历面板：目标岗位 + 分档分 + 操作按钮
    const builder = page.locator('.resume-builder');
    await expect(builder.locator('.resume-panel-head')).toContainText('Senior TypeScript Engineer');
    await expect(builder.locator('.resume-panel-head')).toContainText('Strong match');
    await expect(builder.getByRole('button', { name: 'Print / Save as PDF' })).toBeVisible();
    await expect(builder.getByRole('button', { name: 'Download Markdown' })).toBeVisible();

    // 建议/缺口诚实提示
    await expect(builder.locator('.resume-suggestions')).toContainText('Add your email');

    // iframe srcDoc 渲染服务端 HTML（含打印 CSS 的完整文档）
    const frame = page.frameLocator('.resume-iframe');
    await expect(frame.locator('#marker')).toContainText('RESUME_MARKER');
  });

  test('local details are sent only on apply and persisted in localStorage (never required server-side)', async ({
    page,
  }) => {
    const requests: unknown[] = [];
    await mockRecommendations(page);
    await mockBuild(page, requests);
    await page.goto(`/en/report/${FIXTURE_PROFILE_ID}`);

    await page.locator('.job-recs .rec-resume-button').first().click();
    await expect.poll(() => requests.length).toBe(1);
    // 首次生成不带 local
    expect((requests[0] as Record<string, unknown>).local).toBeUndefined();

    const builder = page.locator('.resume-builder');
    await builder.getByRole('button', { name: /Add local details/ }).click();
    await builder.locator('.resume-local-grid input').first().fill('Alice Zhang');
    await builder.getByRole('button', { name: 'Apply & regenerate' }).click();

    // 第二次请求携带 local.fullName
    await expect.poll(() => requests.length).toBe(2);
    const second = requests[1] as Record<string, unknown>;
    expect(second.local).toMatchObject({ fullName: 'Alice Zhang' });

    // 仅落本机 localStorage
    const stored = await page.evaluate((key) => localStorage.getItem(key), LOCAL_FIELDS_KEY);
    expect(stored).toContain('Alice Zhang');
  });

  test('migrates the legacy resume localStorage key to canonical once, splitting free-text period', async ({
    page,
  }) => {
    const requests: unknown[] = [];
    await mockRecommendations(page);
    await mockBuild(page, requests);
    // 模拟老版本写入的旧键（period 为自由文本）
    await page.addInitScript(
      ([key, value]) => localStorage.setItem(key, JSON.stringify(value)),
      [
        LEGACY_FIELDS_KEY,
        {
          fullName: 'Legacy Li',
          education: [{ school: 'ZJU', degree: 'BS', period: '2018–2022' }],
          workHistory: [{ company: 'ACME', role: 'SDE', period: '2022 - present' }],
        },
      ] as const,
    );
    await page.goto(`/en/report/${FIXTURE_PROFILE_ID}`);

    // 组件挂载即完成一次性迁移：canonical 写入、旧键删除
    const canonical = await page.evaluate((k) => localStorage.getItem(k), LOCAL_FIELDS_KEY);
    expect(canonical).toContain('"start":"2018"');
    expect(canonical).toContain('"end":"2022"');
    const legacy = await page.evaluate((k) => localStorage.getItem(k), LEGACY_FIELDS_KEY);
    expect(legacy).toBeNull();

    // 迁移后的 canonical 经投影进入简历请求，period 由结构化 start/end 重新派生
    await page.locator('.job-recs .rec-resume-button').first().click();
    await expect.poll(() => requests.length).toBe(1);
    expect((requests[0] as Record<string, unknown>).local).toMatchObject({
      fullName: 'Legacy Li',
      education: [{ school: 'ZJU', degree: 'BS', period: '2018 – 2022' }],
    });
  });

  test('shows an error with retry and recovers', async ({ page }) => {
    const requests: unknown[] = [];
    await mockRecommendations(page);
    await mockBuild(page, requests, true);
    await page.goto(`/en/report/${FIXTURE_PROFILE_ID}`);

    await page.locator('.job-recs .rec-resume-button').first().click();
    const builder = page.locator('.resume-builder');
    await expect(builder.getByRole('alert')).toContainText('Could not build the resume');

    await builder.getByRole('button', { name: 'Retry' }).click();
    await expect.poll(() => requests.length).toBe(2);
    await expect(page.frameLocator('.resume-iframe').locator('#marker')).toBeVisible();
  });

  test('renders Chinese button and panel copy under the zh-CN route', async ({ page }) => {
    const requests: unknown[] = [];
    await mockRecommendations(page);
    await mockBuild(page, requests);
    await page.goto(`/zh-CN/report/${FIXTURE_PROFILE_ID}`);

    await expect(
      page.locator('.job-recs').getByRole('button', { name: '针对此岗生成简历' }),
    ).toBeVisible();
    await page.locator('.job-recs .rec-resume-button').first().click();

    await expect.poll(() => requests.length).toBe(1);
    expect((requests[0] as Record<string, unknown>).locale).toBe('zh-CN');
    const builder = page.locator('.resume-builder');
    await expect(builder.getByRole('button', { name: '打印 / 导出 PDF' })).toBeVisible();
  });

  test('auto-builds via the ?resumeJob deep link without clicking a job card (extension entry)', async ({
    page,
  }) => {
    const requests: unknown[] = [];
    await mockRecommendations(page);
    await mockBuild(page, requests);
    await page.goto(`/en/report/${FIXTURE_PROFILE_ID}?resumeJob=job-internal-1`);

    // mount 即自动发起一次 html 生成，jobId 取自 query，无需任何点击
    await expect.poll(() => requests.length).toBe(1);
    expect(requests[0]).toMatchObject({
      profileId: FIXTURE_PROFILE_ID,
      jobId: 'job-internal-1',
      locale: 'en',
      format: 'html',
    });

    // 目标岗位标题由响应 draft 回填（深链未带 title/company）
    const builder = page.locator('.resume-builder');
    await expect(builder.locator('.resume-panel-head')).toContainText('Senior TypeScript Engineer');
    await expect(page.frameLocator('.resume-iframe').locator('#marker')).toBeVisible();
  });

  test('polish toggle sends polish=true and honestly reports the rule-based fallback', async ({ page }) => {
    const requests: Record<string, unknown>[] = [];
    await mockRecommendations(page);
    await page.route(BUILD_URL, async (route) => {
      const post = route.request().postDataJSON() as Record<string, unknown>;
      requests.push(post);
      const polish =
        post.polish === true ? { polish: { requested: true, applied: false, reason: 'not_configured' } } : {};
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ format: 'html', draft: DRAFT, html: RESUME_HTML, ...polish }),
      });
    });
    await page.goto(`/en/report/${FIXTURE_PROFILE_ID}`);
    await page.locator('.job-recs .rec-resume-button').first().click();

    await expect.poll(() => requests.length).toBe(1);
    expect(requests[0].polish).toBeUndefined();

    const builder = page.locator('.resume-builder');
    await builder.getByRole('checkbox', { name: 'Polish wording with AI' }).check();

    // 勾选即重新生成，第二次请求带 polish=true
    await expect.poll(() => requests.length).toBe(2);
    expect(requests[1].polish).toBe(true);

    // 未配置模型时如实显示回退状态 + 原因，不假装已润色
    const status = builder.locator('.resume-polish-status--fallback');
    await expect(status).toContainText('AI polish unavailable');
    await expect(status).toContainText('No model configured');
  });

  test('shows the applied state when the server returns a polished draft', async ({ page }) => {
    const requests: Record<string, unknown>[] = [];
    await mockRecommendations(page);
    await page.route(BUILD_URL, async (route) => {
      const post = route.request().postDataJSON() as Record<string, unknown>;
      requests.push(post);
      const polish = post.polish === true ? { polish: { requested: true, applied: true } } : {};
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ format: 'html', draft: DRAFT, html: RESUME_HTML, ...polish }),
      });
    });
    await page.goto(`/en/report/${FIXTURE_PROFILE_ID}`);
    await page.locator('.job-recs .rec-resume-button').first().click();

    const builder = page.locator('.resume-builder');
    await builder.getByRole('checkbox', { name: 'Polish wording with AI' }).check();
    await expect.poll(() => requests.length).toBe(2);

    await expect(builder.locator('.resume-polish-status--ok')).toContainText('AI wording polish applied');
    await expect(builder.locator('.resume-polish-status--fallback')).toHaveCount(0);
  });
});
