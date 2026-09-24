import { test, expect, type Page } from '@playwright/test';
import { FIXTURE_PROFILE_ID, FIXTURE_LOGIN } from './fixtures/sample-profile.js';

/**
 * 面试计划（interviews，handoff item45）报告页 E2E：
 * - 未登录：/recruit 面试 island 渲染登录墙，登录链接带 return_to 回跳。
 * - 登录后：空态 → 选候选人/填表创建 → 列表出现新面试。
 * - 状态流转到 completed → 展开结果区，登记 outcome/rating/feedback 并 PATCH。
 * webServer 只起 Astro（SSR），/auth/me、/candidates、/interviews 全部 page.route mock，零网络。
 */

interface MockInterview {
  id: string;
  profileId: string;
  applicationId: string | null;
  targetTitle: string;
  targetCompany: string | null;
  scheduledStart: string;
  scheduledEnd: string;
  format: 'onsite' | 'phone' | 'video';
  roundLabel: string;
  interviewerName: string | null;
  interviewerEmail: string | null;
  status: 'scheduled' | 'completed' | 'cancelled' | 'no_show' | 'rescheduled';
  outcome: 'strong_yes' | 'yes' | 'neutral' | 'no' | null;
  feedbackNote: string | null;
  rating: number | null;
  createdAt: string;
  updatedAt: string;
}

function authMeUser(): Record<string, unknown> {
  return {
    kind: 'user',
    platform: 'github',
    login: 'alice',
    name: 'Alice',
    avatarUrl: null,
    profileUrl: null,
    claimedProfileId: null,
    expiresAt: '2026-12-31T00:00:00.000Z',
  };
}

const CANDIDATES = {
  items: [
    {
      profileId: FIXTURE_PROFILE_ID,
      platform: 'github',
      login: FIXTURE_LOGIN,
      displayName: FIXTURE_LOGIN,
      profileUrl: `https://github.com/${FIXTURE_LOGIN}`,
      claimed: false,
      headline: 'fixture developer',
      authenticity: { status: 'likely_authentic', confidence: 0.9 },
      skills: [],
      skillCount: 0,
      matchedSkills: [],
      updatedAt: '2026-09-20T00:00:00.000Z',
    },
  ],
  total: 1,
  limit: 100,
  offset: 0,
};

async function mockAuth(page: Page, kind: 'user' | 'anonymous') {
  await page.route('**/auth/me', (route) =>
    route.fulfill({
      status: 200,
      json: kind === 'user' ? authMeUser() : { kind: 'anonymous' },
    }),
  );
  // 招聘工作台 island 也会请求 /candidates，统一返回 fixture 候选人
  await page.route('**/candidates**', (route) =>
    route.fulfill({ status: 200, json: CANDIDATES }),
  );
}

function interviewRoutes(store: MockInterview[]) {
  return async (page: Page) => {
    await page.route('**/interviews**', async (route) => {
      const request = route.request();
      const method = request.method();
      const pathname = new URL(request.url()).pathname;
      const isCollection = pathname.endsWith('/interviews');

      if (method === 'GET' && isCollection) {
        return route.fulfill({ status: 200, json: { items: store } });
      }
      if (method === 'POST' && isCollection) {
        const body = (request.postDataJSON() ?? {}) as Partial<MockInterview>;
        const now = '2026-09-24T00:00:00.000Z';
        const record: MockInterview = {
          id: 'int-e2e-1',
          profileId: body.profileId ?? FIXTURE_PROFILE_ID,
          applicationId: body.applicationId ?? null,
          targetTitle: body.targetTitle ?? '',
          targetCompany: body.targetCompany ?? null,
          scheduledStart: body.scheduledStart ?? '',
          scheduledEnd: body.scheduledEnd ?? '',
          format: body.format ?? 'video',
          roundLabel: body.roundLabel ?? '',
          interviewerName: body.interviewerName ?? null,
          interviewerEmail: body.interviewerEmail ?? null,
          status: 'scheduled',
          outcome: null,
          feedbackNote: null,
          rating: null,
          createdAt: now,
          updatedAt: now,
        };
        store.push(record);
        return route.fulfill({ status: 201, json: record });
      }
      if (method === 'PATCH' && !isCollection) {
        const patch = (request.postDataJSON() ?? {}) as Partial<MockInterview>;
        const idx = store.findIndex((it) => pathname.endsWith(`/interviews/${it.id}`));
        if (idx === -1) return route.fulfill({ status: 404, json: { error: 'not found' } });
        store[idx] = { ...store[idx], ...patch };
        return route.fulfill({ status: 200, json: store[idx] });
      }
      return route.continue();
    });
  };
}

test.describe('interview planner — login gate', () => {
  test('anonymous visitors see a login gate with a return_to link', async ({ page }) => {
    await mockAuth(page, 'anonymous');
    await page.route('**/interviews**', (route) =>
      route.fulfill({ status: 401, json: { error: 'authentication required' } }),
    );

    await page.goto('/en/recruit');

    const gate = page.getByTestId('interview-login-gate');
    await expect(gate).toBeVisible();
    const loginButton = page.getByTestId('interview-login-button');
    await expect(loginButton).toBeVisible();
    const href = await loginButton.getAttribute('href');
    expect(href).toContain('/auth/github/login');
    expect(href).toContain('return_to=%2Fen%2Frecruit');
  });
});

test.describe('interview planner — signed in', () => {
  test.beforeEach(async ({ context }) => {
    await context.addCookies([
      { name: 'jobagent_session', value: 'ses-e2e-interview', domain: 'localhost', path: '/' },
    ]);
  });

  test('schedules an interview from a candidate and lists it', async ({ page }) => {
    await mockAuth(page, 'user');
    const store: MockInterview[] = [];
    await interviewRoutes(store)(page);

    await page.goto('/en/recruit');

    const planner = page.locator('.ivp');
    await expect(planner).toContainText('Interview planner');
    await expect(planner).toContainText('No interviews scheduled yet');

    await planner.getByRole('button', { name: /schedule interview/i }).click();
    await planner.locator('#ivp-candidate').selectOption(FIXTURE_PROFILE_ID);
    await planner.locator('#ivp-role').fill('Senior Backend Engineer');
    await planner.locator('#ivp-company').fill('Acme');
    await planner.locator('#ivp-start').fill('2026-10-01T09:00');
    await planner.locator('#ivp-end').fill('2026-10-01T10:00');
    await planner.locator('#ivp-round').fill('Technical screen');
    await planner.getByRole('button', { name: /^Create interview$/i }).click();

    const item = planner.getByTestId('interview-item');
    await expect(item).toHaveCount(1);
    await expect(item).toContainText(`@${FIXTURE_LOGIN} · github`);
    await expect(item).toContainText('Senior Backend Engineer');
    await expect(item).toContainText('Acme');
    await expect(item).toContainText('Technical screen');
  });

  test('moves an interview to completed and records the outcome', async ({ page }) => {
    await mockAuth(page, 'user');
    const store: MockInterview[] = [
      {
        id: 'int-e2e-existing',
        profileId: FIXTURE_PROFILE_ID,
        applicationId: null,
        targetTitle: 'Backend Engineer',
        targetCompany: 'Acme',
        scheduledStart: '2026-10-03T09:00:00.000Z',
        scheduledEnd: '2026-10-03T10:00:00.000Z',
        format: 'video',
        roundLabel: 'Final round',
        interviewerName: null,
        interviewerEmail: null,
        status: 'scheduled',
        outcome: null,
        feedbackNote: null,
        rating: null,
        createdAt: '2026-09-24T00:00:00.000Z',
        updatedAt: '2026-09-24T00:00:00.000Z',
      },
    ];
    await interviewRoutes(store)(page);

    await page.goto('/en/recruit');
    const item = page.getByTestId('interview-item');

    // 状态切到 completed → 乐观更新并展开结果区（同时触发一次只含 status 的 PATCH）
    await item.locator('.ivp-status select').selectOption('completed');
    const result = page.getByTestId('interview-result');
    await expect(result).toBeVisible();

    // 登记结论 / 评分 / 反馈并保存；保存按钮触发第二次 PATCH（含 outcome/rating/feedbackNote），
    // waitForRequest 在 click 前注册，捕获这次请求。
    const selects = result.locator('select');
    await selects.nth(0).selectOption('yes');
    await selects.nth(1).selectOption('4');
    await result.locator('textarea').fill('Solid system design; move forward.');
    const savePatch = page.waitForRequest(
      (req) =>
        req.method() === 'PATCH' &&
        req.url().includes('/interviews/int-e2e-existing') &&
        (req.postDataJSON() as Record<string, unknown>)?.outcome === 'yes',
    );
    await result.getByRole('button', { name: /save outcome/i }).click();
    const req = await savePatch;
    const body = req.postDataJSON() as Record<string, unknown>;
    expect(body.status).toBe('completed');
    expect(body.outcome).toBe('yes');
    expect(body.rating).toBe(4);
    expect(body.feedbackNote).toContain('Solid system design');
  });
});
