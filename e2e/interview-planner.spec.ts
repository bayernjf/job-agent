import { test, expect, type Page } from '@playwright/test';
import {
  FIXTURE_CLAIMED_PROFILE_ID,
  FIXTURE_LOGIN,
  FIXTURE_SESSION_TOKEN,
} from './fixtures/sample-profile.js';

/**
 * 求职者面试管道（T18）E2E：组件从 /recruit 挪到 /[locale]/my 后按求职者视角重写。
 * - 匿名：/my 页由 GateCard 承担登录墙（return_to 回跳 /en/my）。
 * - 登录（FIXTURE_SESSION_TOKEN 真实会话）：SSR 列出本人画像并挂载 InterviewPlanner，
 *   建行从「我的投递」选 applicationId 真接上（POST body 断言），列表展示岗位/轮次/状态。
 * - 状态流转到 completed → 展开结果区，登记 outcome/rating/feedback 并 PATCH。
 * webServer 只起 Astro（SSR），/auth/me、/profiles/:id/applications、/interviews
 * 全部 page.route mock，零网络。
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
    login: FIXTURE_LOGIN,
    name: 'E2E Fixture',
    avatarUrl: null,
    profileUrl: null,
    claimedProfileId: FIXTURE_CLAIMED_PROFILE_ID,
    expiresAt: '2030-01-01T00:00:00.000Z',
  };
}

/** 本人画像名下的一条"已投递"记录（saved/applied/viewed 可推进为面试）。 */
const APPLICATIONS = {
  items: [
    {
      id: 'app-e2e-1',
      profileId: FIXTURE_CLAIMED_PROFILE_ID,
      jobId: null,
      targetTitle: 'Senior Backend Engineer',
      targetCompany: 'Acme',
      status: 'applied',
      note: null,
      appliedAt: '2026-09-20T00:00:00.000Z',
    },
  ],
};

async function mockAuthAndApplications(page: Page) {
  await page.route('**/auth/me', (route) =>
    route.fulfill({ status: 200, json: authMeUser() }),
  );
  await page.route('**/profiles/*/applications', (route) =>
    route.fulfill({ status: 200, json: APPLICATIONS }),
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
        const now = '2026-09-26T00:00:00.000Z';
        const record: MockInterview = {
          id: 'int-e2e-1',
          profileId: body.profileId ?? FIXTURE_CLAIMED_PROFILE_ID,
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

test.describe('my interviews — login gate', () => {
  test('anonymous visitors see the my-page login gate with a return_to link', async ({ page }) => {
    await page.route('**/auth/me', (route) =>
      route.fulfill({ status: 200, json: { kind: 'anonymous' } }),
    );

    await page.goto('/en/my');

    const gate = page.getByTestId('my-gate');
    await expect(gate).toBeVisible();
    const loginButton = gate.getByRole('link', { name: /sign in/i }).first();
    await expect(loginButton).toBeVisible();
    const href = await loginButton.getAttribute('href');
    expect(href).toContain('/auth/github/login');
    expect(href).toContain('return_to=%2Fen%2Fmy');
  });
});

test.describe('my interviews — signed in', () => {
  test.beforeEach(async ({ context }) => {
    await context.addCookies([
      {
        name: 'jobagent_session',
        value: FIXTURE_SESSION_TOKEN,
        domain: 'localhost',
        path: '/',
      },
    ]);
  });

  test('schedules an interview from one of my applications and lists it', async ({ page }) => {
    await mockAuthAndApplications(page);
    const store: MockInterview[] = [];
    await interviewRoutes(store)(page);

    await page.goto('/en/my');

    const planner = page.locator('.ivp');
    await expect(planner).toContainText('My interviews');
    await expect(planner).toContainText('No interviews yet');

    await planner.getByRole('button', { name: /schedule interview/i }).click();
    // 从「我的投递」选一条已投递记录（T18：applicationId 真接上）
    await planner.locator('#ivp-application').selectOption('app-e2e-1');
    // 选投递后自动带出岗位/公司，仍可手改
    const roleInput = planner.locator('#ivp-role');
    await expect(roleInput).toHaveValue('Senior Backend Engineer');
    const companyInput = planner.locator('#ivp-company');
    await expect(companyInput).toHaveValue('Acme');
    await planner.locator('#ivp-start').fill('2026-10-01T09:00');
    await planner.locator('#ivp-end').fill('2026-10-01T10:00');
    await planner.locator('#ivp-round').fill('Technical screen');

    const createReq = page.waitForRequest(
      (req) =>
        req.method() === 'POST' &&
        req.url().includes('/interviews') &&
        (req.postDataJSON() as Record<string, unknown>)?.applicationId === 'app-e2e-1',
    );
    await planner.getByRole('button', { name: /^Create interview$/i }).click();
    const req = await createReq;
    const body = req.postDataJSON() as Record<string, unknown>;
    expect(body.profileId).toBe(FIXTURE_CLAIMED_PROFILE_ID);
    expect(body.applicationId).toBe('app-e2e-1');
    expect(body.targetTitle).toBe('Senior Backend Engineer');
    expect(body.targetCompany).toBe('Acme');

    const item = planner.getByTestId('interview-item');
    await expect(item).toHaveCount(1);
    await expect(item).toContainText('Senior Backend Engineer');
    await expect(item).toContainText('Acme');
    await expect(item).toContainText('Technical screen');
  });

  test('moves an interview to completed and records the outcome', async ({ page }) => {
    await mockAuthAndApplications(page);
    const store: MockInterview[] = [
      {
        id: 'int-e2e-existing',
        profileId: FIXTURE_CLAIMED_PROFILE_ID,
        applicationId: 'app-e2e-1',
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

    await page.goto('/en/my');
    const item = page.getByTestId('interview-item');

    // 状态切到 completed → 乐观更新并展开结果区（同时触发一次只含 status 的 PATCH）
    await item.locator('.ivp-status select').selectOption('completed');
    const result = page.getByTestId('interview-result');
    await expect(result).toBeVisible();

    // 登记结论 / 评分 / 反馈并保存；保存按钮触发第二次 PATCH（含 outcome/rating/feedbackNote）
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
