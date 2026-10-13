import { test, expect, type Route } from '@playwright/test';
import {
  FIXTURE_PROFILE_ID,
  FIXTURE_RECRUITER_SESSION_TOKEN,
} from './fixtures/sample-profile.js';

/**
 * 招聘方自建 JD（决策 #25，B3-a 最小一刀，2026-10-13）的报告页 E2E。
 *
 * 覆盖的是"真人点得动的路"：声明招聘方 → /en/recruit 发布一条私有 JD → 立刻按它排候选人。
 * 三个端点用 page.route mock（本套件不打真实 API），候选人读取口断言的是**真实请求 URL**，
 * 这样"复用 GET /candidates 的 skills 过滤"这条设计约束被钉住，而不是只测渲染。
 */

const MY_POSTINGS_URL = '**/job-postings/recruiter*';
const CANDIDATES_URL = '**/candidates*';

interface MockPosting {
  id: string;
  title: string;
  company: string;
  location: string | null;
  remote: boolean;
  tags: string[];
  status: 'active' | 'inactive';
  postedAt: string;
}

test.describe('recruiter-published job descriptions', () => {
  test.beforeEach(async ({ context }) => {
    await context.addCookies([
      {
        name: 'jobagent_session',
        value: FIXTURE_RECRUITER_SESSION_TOKEN,
        domain: '127.0.0.1',
        path: '/',
      },
    ]);
  });

  test('publishes a private JD and ranks candidates through the existing candidate filter', async ({
    page,
  }) => {
    const postings: MockPosting[] = [
      {
        id: 'jp-existing',
        title: 'Existing Role',
        company: 'Platform Team',
        location: 'Shanghai',
        remote: false,
        tags: ['go', 'kubernetes'],
        status: 'active',
        postedAt: '2026-10-01T00:00:00.000Z',
      },
    ];

    await page.route(MY_POSTINGS_URL, async (route: Route) => {
      if (route.request().method() === 'POST') {
        const body = route.request().postDataJSON() as Partial<MockPosting>;
        const created: MockPosting = {
          id: 'jp-new',
          title: String(body.title),
          company: String(body.company),
          location: body.location ?? null,
          remote: !!body.remote,
          tags: body.tags ?? [],
          status: 'active',
          postedAt: '2026-10-13T00:00:00.000Z',
        };
        postings.unshift(created);
        await route.fulfill({ json: created });
        return;
      }
      await route.fulfill({ json: { items: postings, limit: 100, offset: 0 } });
    });

    const candidateRequests: string[] = [];
    await page.route(CANDIDATES_URL, async (route: Route) => {
      candidateRequests.push(new URL(route.request().url()).search);
      await route.fulfill({
        json: {
          items: [
            {
              profileId: FIXTURE_PROFILE_ID,
              platform: 'github',
              login: 'e2e-fixture-user',
              displayName: 'E2E Fixture User',
              profileUrl: 'https://github.com/e2e-fixture-user',
              claimed: false,
              headline: 'Builds agent tooling in TypeScript',
              authenticity: { status: 'likely_authentic', confidence: 0.8 },
              skills: [{ name: 'typescript', kind: 'language', depth: 'proficient', confidence: 0.8 }],
              skillCount: 1,
              matchedSkills: ['typescript'],
              verifiedClaimCount: 2,
              updatedAt: '2026-10-13T00:00:00.000Z',
            },
          ],
          total: 1,
        },
      });
    });

    // 决策 #25 补口（迁移 037）：同一次展开还要读这条岗位下的面试
    const interviewRequests: string[] = [];
    await page.route('**/interviews**', async (route: Route) => {
      interviewRequests.push(new URL(route.request().url()).search);
      await route.fulfill({
        json: {
          items: [
            {
              id: 'int-e2e-1',
              profileId: FIXTURE_PROFILE_ID,
              postingId: 'jp-new',
              targetTitle: 'Staff Agent Engineer',
              roundLabel: '一面 · 技术筛',
              scheduledStart: '2026-10-20T09:00:00.000Z',
              scheduledEnd: '2026-10-20T10:00:00.000Z',
              status: 'scheduled',
              outcome: null,
            },
          ],
        },
      });
    });

    await page.goto('/en/recruit');

    // 首屏：SSR 只给候选人工作台数据，"我的岗位"由 island 拉取后出现
    await expect(page.locator('#recruit-jd-title')).toContainText('My job descriptions');
    await expect(page.getByTestId('jd-item')).toHaveCount(1);
    await expect(page.getByText('Existing Role')).toBeVisible();

    await page.getByTestId('jd-title').fill('Staff Agent Engineer');
    await page.getByTestId('jd-company').fill('In-house Team');
    await page.getByTestId('jd-tags').fill('typescript, agents');
    await page.getByTestId('jd-submit').click();

    await expect(page.getByText('Staff Agent Engineer')).toBeVisible();
    await expect(page.getByTestId('jd-item')).toHaveCount(2);

    // 按这条岗位排候选人：走的是既有 GET /candidates，技能来自 JD 标签
    await page.getByTestId('jd-rank').first().click();
    await expect(page.getByText('1 candidates matched this role')).toBeVisible();
    await expect(page.getByTestId('jd-cand-link')).toHaveCount(1);

    const query = new URLSearchParams(candidateRequests[0] ?? '');
    expect(query.get('skills')).toBe('typescript,agents');
    expect(query.get('skillMatch')).toBe('any');
    expect(query.get('sortBy')).toBe('skills');

    // 候选人链接指向报告页招聘方核验视图（同一条核验路，不另开入口）
    const href = await page.getByTestId('jd-cand-link').getAttribute('href');
    expect(href).toContain(`/en/report/${FIXTURE_PROFILE_ID}?view=recruiter`);

    // 同一面板里读出这条岗位已排的面试，读侧按 postingId 收窄
    await expect(page.getByTestId('jd-interview-item')).toHaveCount(1);
    await expect(page.getByText('一面 · 技术筛')).toBeVisible();
    expect(interviewRequests[0] ?? '').toContain('postingId=jp-new');
    const interviewHref = await page.getByTestId('jd-interview-link').getAttribute('href');
    expect(interviewHref).toContain(`/en/report/${FIXTURE_PROFILE_ID}?view=recruiter`);
  });

  test('a posting without skill tags cannot be used to rank candidates', async ({ page }) => {
    await page.route(MY_POSTINGS_URL, async (route: Route) => {
      await route.fulfill({
        json: {
          items: [
            {
              id: 'jp-untagged',
              title: 'Untagged Role',
              company: 'Ops',
              location: null,
              remote: true,
              tags: [],
              status: 'active',
              postedAt: '2026-10-13T00:00:00.000Z',
            },
          ],
          limit: 100,
          offset: 0,
        },
      });
    });
    await page.route(CANDIDATES_URL, async (route: Route) => {
      await route.fulfill({ json: { items: [], total: 0 } });
    });

    await page.goto('/en/recruit');
    const rank = page.getByTestId('jd-rank');
    await expect(rank).toBeDisabled();
    await expect(rank).toHaveAttribute('title', /skill tag/);
  });
});
