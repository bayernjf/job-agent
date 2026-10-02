import { test, expect, type Page, type Route } from '@playwright/test';
import { preloadAstro } from './preload.js';
import {
  FIXTURE_CLAIMED_PROFILE_ID,
  FIXTURE_LOGIN,
  FIXTURE_SESSION_TOKEN,
} from './fixtures/sample-profile.js';

/**
 * 求职工作台 E2E（设计 docs/设计-求职Agent-20261002.md 阶段 1，/[locale]/workbench）。
 *
 * - 匿名：SSR 登录墙（GateCard，data-testid="workbench-gate"）+ 同源 return_to。
 * - 登录：FIXTURE_SESSION_TOKEN 真实会话让报告页 SSR 认出 user 并挂载 AgentWorkbench 岛；
 *   岛内全部 /agent/* 请求由 page.route mock（本阶段 API 并行开发中，零真实网络、零岗位池）。
 * - 断言覆盖人机闸的两条路径（确认/拒绝的 POST body）、空态、错误态，以及最关键的
 *   「匹配理由必须渲染本地化文案，而不是契约里的英文 snake_case code」。
 * webServer 只起 Astro（SSR），Mock 数据自足。
 */

const WORKBENCH_PATH = '/en/workbench';
const RUN_ID = 'run-e2e-1';
const PREFERENCE_ID = 'pref-e2e-1';

const RUN = {
  runId: RUN_ID,
  accountId: 'acc-e2e-1',
  profileId: FIXTURE_CLAIMED_PROFILE_ID,
  preferenceId: PREFERENCE_ID,
  status: 'awaiting_approval',
  attempts: 1,
  lastError: null,
  lastScanAt: '2026-10-02T08:30:00.000Z',
  createdAt: '2026-10-01T08:00:00.000Z',
  updatedAt: '2026-10-02T08:30:00.000Z',
};

const PREFERENCE = {
  preferenceId: PREFERENCE_ID,
  accountId: 'acc-e2e-1',
  label: 'Remote full-stack',
  targetTitles: ['backend engineer'],
  skills: ['TypeScript'],
  locations: [],
  remoteOnly: true,
  salaryMinUsd: 90000,
  sources: [],
  companyWhitelist: [],
  companyBlacklist: [],
  minTier: 'mid',
  dailySubmitLimit: 20,
  createdAt: '2026-10-01T08:00:00.000Z',
  updatedAt: '2026-10-01T08:00:00.000Z',
};

const EVENT = {
  eventId: 'evt-e2e-1',
  runId: RUN_ID,
  event: 'generated',
  fromStatus: 'recommending',
  toStatus: 'awaiting_approval',
  actor: 'agent',
  payload: {},
  createdAt: '2026-10-02T08:30:00.000Z',
};

const INTENT = {
  intentId: 'intent-e2e-1',
  runId: RUN_ID,
  accountId: 'acc-e2e-1',
  profileId: FIXTURE_CLAIMED_PROFILE_ID,
  job: {
    jobId: 'job-e2e-1',
    source: 'remoteok',
    sourceUrl: 'https://example.test/job-e2e-1',
    applyUrl: 'https://example.test/apply/job-e2e-1',
    title: 'Senior TypeScript Engineer',
    company: 'Acme Corp',
    location: 'Remote',
    remote: true,
    salaryMin: 140000,
    salaryMax: 180000,
    salaryCurrency: 'USD',
    tags: ['typescript', 'node'],
    postedAt: '2026-10-01T00:00:00.000Z',
  },
  matchScore: 9,
  matchTier: 'high',
  report: {
    ruleVersion: '0.1',
    score: 9,
    tier: 'high',
    fieldScores: { title: 3, tags: 4, description: 2 },
    matchedSkills: ['TypeScript'],
    reasons: [{ code: 'title_match', skill: 'TypeScript', points: 3 }],
    gaps: [{ code: 'tag_not_in_profile', tag: 'kubernetes' }],
    suggestedBoost: [{ code: 'add_evidence_for_tag', skill: 'kubernetes' }],
  },
  status: 'pending',
  rejectReason: null,
  approvedAt: null,
  rejectedAt: null,
  submittedAt: null,
  createdAt: '2026-10-02T08:30:00.000Z',
  updatedAt: '2026-10-02T08:30:00.000Z',
};

const APPROVE_MATCH = '**/agent/runs/*/approve';
const REJECT_MATCH = '**/agent/runs/*/reject';

interface WorkbenchMocks {
  /** 待投清单条目（默认一条 pending 票据） */
  pendingItems?: unknown[];
  /** 非 pending 端点的统一失败状态码（500 → role=alert） */
  failStatus?: number;
  /** 请求记录（确认/拒绝的 body 断言用） */
  requests?: { approve: unknown[]; reject: unknown[] };
}

/** 把 /agent/* 全部 mock 掉：人机闸两条动作单独记录 body，其余按端点回固定夹具。 */
async function mockAgent(page: Page, mocks: WorkbenchMocks = {}): Promise<void> {
  const { pendingItems = [INTENT], failStatus, requests } = mocks;

  await page.route('**/agent/**', async (route: Route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    const method = request.method();

    if (method === 'POST' && pathname.endsWith('/approve')) {
      requests?.approve.push(request.postDataJSON());
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          run: { ...RUN, status: 'submitted' },
          events: [EVENT],
          intents: [{ ...INTENT, status: 'approved' }],
          approved: 1,
        }),
      });
    }

    if (method === 'POST' && pathname.endsWith('/reject')) {
      requests?.reject.push(request.postDataJSON());
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          run: { ...RUN, status: 'watching' },
          events: [EVENT],
          intents: [{ ...INTENT, status: 'rejected' }],
        }),
      });
    }

    if (failStatus) {
      return route.fulfill({
        status: failStatus,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'boom' }),
      });
    }

    if (pathname.endsWith('/pending-approvals')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ runId: RUN_ID, status: RUN.status, items: pendingItems }),
      });
    }

    if (pathname.endsWith('/agent/runs')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ runs: [RUN] }),
      });
    }

    if (pathname.endsWith('/agent/preferences')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ preferences: [PREFERENCE] }),
      });
    }

    if (pathname.includes('/agent/runs/')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          run: RUN,
          events: [EVENT],
          intents: pendingItems,
        }),
      });
    }

    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({}),
    });
  });
}

/** 登录（真实 fixture 会话 cookie，与 interview-planner.spec.ts 同一手法）。 */
async function signIn(page: Page): Promise<void> {
  await page.context().addCookies([
    { name: 'jobagent_session', value: FIXTURE_SESSION_TOKEN, domain: 'localhost', path: '/' },
  ]);
}

test.beforeAll(async ({ baseURL }) => {
  // 冷路由预热（T29）：本 spec 新增 /workbench 路由，先编译一次避免首例承担冷启动。
  await preloadAstro(baseURL ?? 'http://127.0.0.1:4321');
});

test.describe('job workbench — login gate', () => {
  test('anonymous visitors see the workbench gate with a return_to link', async ({ page }) => {
    await page.goto(WORKBENCH_PATH);

    const gate = page.getByTestId('workbench-gate');
    await expect(gate).toBeVisible();
    await expect(gate).toContainText('Sign in to use the job workbench');

    const login = gate.getByRole('link', { name: /sign in/i }).first();
    await expect(login).toBeVisible();
    const href = await login.getAttribute('href');
    expect(href).toContain('/auth/github/login');
    expect(href).toContain('return_to=%2Fen%2Fworkbench');

    // 登录墙存在时不得渲染工作台岛
    await expect(page.getByTestId('agent-workbench')).toHaveCount(0);
  });
});

test.describe('job workbench — signed in', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
  });

  test('renders a pending intent with localized match reasons and confirms it with the right body', async ({
    page,
  }) => {
    const requests = { approve: [] as unknown[], reject: [] as unknown[] };
    await mockAgent(page, { requests });
    await page.goto(WORKBENCH_PATH);

    const workbench = page.getByTestId('agent-workbench');
    await expect(workbench).toBeVisible();
    await expect(workbench).toContainText('Job workbench');

    const pending = page.getByTestId('agent-pending');
    const intent = pending.getByTestId('agent-intent');
    await expect(intent).toHaveCount(1);

    // 岗位事实：标题 / 公司 / 远程标签
    await expect(intent).toContainText('Senior TypeScript Engineer');
    await expect(intent).toContainText('Acme Corp');
    await expect(intent).toContainText('Remote');

    // 分档 chip 用与报告页一致的 rec-score--tier 类名（不新增色板）
    const tier = intent.getByTestId('agent-intent-tier');
    await expect(tier).toHaveClass(/rec-score--high/);
    await expect(tier).toHaveText('Strong match');

    // 匹配报告从 code 现拼：文案是英文句子，绝不是契约里的 snake_case code
    await intent.locator('.agent-match summary').click();
    const reasons = intent.locator('.agent-match-list').first();
    await expect(reasons).toContainText('Job title matches "TypeScript"');
    await expect(reasons).not.toContainText('title_match');
    await expect(intent.locator('.agent-match')).not.toContainText('tag_not_in_profile');
    await expect(intent.locator('.agent-match')).toContainText('kubernetes');

    // 确认：POST /agent/runs/:id/approve，body 只含这一个票据 id
    const approveReq = page.waitForRequest(
      (req) => req.method() === 'POST' && req.url().includes(`/agent/runs/${RUN_ID}/approve`),
    );
    await intent.getByRole('button', { name: 'Approve' }).click();
    await approveReq;

    expect(requests.approve).toHaveLength(1);
    expect(requests.approve[0]).toEqual({ intentIds: [INTENT.intentId] });
  });

  test('reject sends the reason together with the intent id', async ({ page }) => {
    const requests = { approve: [] as unknown[], reject: [] as unknown[] };
    await mockAgent(page, { requests });
    await page.goto(WORKBENCH_PATH);

    const intent = page.getByTestId('agent-intent');
    await expect(intent).toHaveCount(1);

    await intent
      .getByLabel('Rejection reason (optional)')
      .fill('Not my direction');
    const rejectReq = page.waitForRequest(
      (req) => req.method() === 'POST' && req.url().includes(`/agent/runs/${RUN_ID}/reject`),
    );
    await intent.getByRole('button', { name: 'Reject' }).click();
    await rejectReq;

    expect(requests.reject).toHaveLength(1);
    expect(requests.reject[0]).toEqual({
      intentId: INTENT.intentId,
      reason: 'Not my direction',
    });
  });

  test('shows the empty state when nothing is waiting for approval', async ({ page }) => {
    await mockAgent(page, { pendingItems: [] });
    await page.goto(WORKBENCH_PATH);

    const pending = page.getByTestId('agent-pending');
    await expect(pending.getByTestId('agent-pending-empty')).toContainText(
      'No jobs waiting for your approval',
    );
    await expect(pending.getByTestId('agent-intent')).toHaveCount(0);
  });

  test('surfaces a role=alert error when the API fails', async ({ page }) => {
    await mockAgent(page, { failStatus: 500 });
    await page.goto(WORKBENCH_PATH);

    const workbench = page.getByTestId('agent-workbench');
    const alert = workbench.getByRole('alert').first();
    await expect(alert).toBeVisible();
    await expect(alert).toContainText('Failed to load the job workbench');
  });

  test('renders Chinese copy and Chinese match reasons under the zh-CN route', async ({ page }) => {
    await mockAgent(page);
    await page.goto('/zh-CN/workbench');

    const intent = page.getByTestId('agent-intent');
    await expect(intent).toHaveCount(1);
    await expect(page.getByTestId('agent-pending')).toContainText('待投清单');
    await expect(intent.getByTestId('agent-intent-tier')).toHaveText('高度匹配');
    await intent.locator('.agent-match summary').click();
    await expect(intent.locator('.agent-match-list').first()).toContainText('TypeScript');
    await expect(intent.locator('.agent-match-list').first()).not.toContainText('title_match');
  });

  test('exposes the run event timeline so a run can be replayed', async ({ page }) => {
    await mockAgent(page);
    await page.goto(WORKBENCH_PATH);

    const timeline = page.getByTestId('agent-timeline');
    await expect(timeline).toBeVisible();
    const event = timeline.getByTestId('agent-event').first();
    // 事件码 → 本地化文案 + from → to（状态同样走 labels.statuses，不暴露 recommending 这类内部码）+ 动作方
    await expect(event).toContainText('Reports and materials generated');
    await expect(event).toContainText('Building recommendations');
    await expect(event).toContainText('Awaiting your approval');
    await expect(event).not.toContainText('awaiting_approval');
    await expect(event).toContainText('Actor: Agent');
    await expect(event.locator('time')).toHaveAttribute('datetime', EVENT.createdAt);
  });
});
