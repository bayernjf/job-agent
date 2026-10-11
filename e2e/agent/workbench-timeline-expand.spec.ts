/**
 * 求职工作台「事件流增量展开」真全栈 E2E（2026-10-12）。
 *
 * 回归背景：生产实测一个长 run 展开后把整个已加载窗口一次摊开（12000+px 长页、
 * 收起按钮被顶走）。修复（EVENT_EXPAND_STEP=50）只改了展示层，后端分页早已生效，
 * 但此前没有任何自动化点过展开分支。本用例直接写库造一个含 60 条迁移事件的 run
 * （56 条相邻 rescan 自迁移，折叠态只应占 1 行），在真浏览器里钉死四条不变量：
 *
 * 1. 折叠态：相邻同质迁移折叠，60 条 → 5 行；
 * 2. 首次展开：只摊最近 50 条，head 仍折叠（3 折叠行 + 50 单条 = 53 行），
 *    「展开更早的 N 条」按钮提示剩余 10 条；
 * 3. 再点一次：60 条全摊开，出现「已全部展开」，增量按钮消失；
 * 4. 收起：回到折叠态行数，展开计数被重置（再展开仍是 50 而不是 60）。
 */
import { test, expect, type Page } from '@playwright/test';
import { createStorage } from '@jobagent/storage';
import {
  AGENT_DB,
  FIXTURE_ACCOUNT_ID,
  FIXTURE_PROFILE_ID,
  default as resetAgentFixtures,
} from './global-setup';
import { API, authHeaders, login } from './helpers';

const WORKBENCH = '/en/workbench';
const TOTAL_EVENTS = 60;
const EXPAND_STEP = 50;

/**
 * 直接写库造一个 awaiting_approval 的 run，事件序列（升序 60 条）：
 * validate → start → rescan×56（watching 自迁移，相邻同质）→ candidates_ready → generated。
 * 不走状态机 API：状态机一轮只产 4–5 条事件，无法在零网络下造出长审计流。
 */
async function seedRunWithLongTimeline(): Promise<string> {
  const runId = 'run-timeline-big';
  const base = Date.parse('2026-10-12T00:00:00.000Z');
  const at = (i: number) => new Date(base + i * 60_000).toISOString();

  // 先经真 API 建偏好（契约校验与真实链路一致），再直接写库挂 run。
  const prefRes = await fetch(`${API}/agent/preferences`, {
    method: 'POST',
    headers: { ...authHeaders, 'content-type': 'application/json' },
    body: JSON.stringify({
      label: 'E2E · timeline',
      targetTitles: ['typescript', 'engineer'],
      skills: ['TypeScript'],
      remoteOnly: false,
      minTier: 'mid',
    }),
  });
  if (!prefRes.ok) throw new Error(`seed preference failed: ${prefRes.status}`);
  const { preference } = (await prefRes.json()) as {
    preference: { preferenceId: string };
  };

  const repos = await createStorage({ sqlitePath: AGENT_DB });
  try {
    await repos.jobRuns.insert({
      id: runId,
      accountId: FIXTURE_ACCOUNT_ID,
      profileId: FIXTURE_PROFILE_ID,
      preferenceId: preference.preferenceId,
      createdAt: at(0),
    });

    const events: Array<{
      event: 'validate' | 'start' | 'rescan' | 'candidates_ready' | 'generated';
      from: string | null;
      to: string;
    }> = [
      { event: 'validate', from: 'created', to: 'configured' },
      { event: 'start', from: 'configured', to: 'watching' },
      ...Array.from({ length: TOTAL_EVENTS - 4 }, () => ({
        event: 'rescan' as const,
        from: 'watching',
        to: 'watching',
      })),
      { event: 'candidates_ready', from: 'watching', to: 'recommending' },
      { event: 'generated', from: 'recommending', to: 'awaiting_approval' },
    ];

    for (let i = 0; i < events.length; i += 1) {
      const e = events[i];
      await repos.jobRunEvents.insert({
        id: `evt-big-${String(i).padStart(2, '0')}`,
        runId,
        event: e.event,
        fromStatus: e.from as never,
        toStatus: e.to as never,
        actor: i === 0 ? 'system' : 'agent',
        payload: {},
        createdAt: at(i),
      });
    }

    await repos.jobRuns.setStatus(runId, {
      status: 'awaiting_approval',
      updatedAt: at(TOTAL_EVENTS - 1),
    });
  } finally {
    await repos.close();
  }
  return runId;
}

async function openRunHydrated(page: Page): Promise<void> {
  const runsReady = page.waitForResponse(
    (r) => r.url().includes('/agent/runs') && r.request().method() === 'GET' && r.status() === 200,
  );
  await page.goto(WORKBENCH);
  await expect(page.getByTestId('agent-workbench')).toBeVisible();
  await runsReady;

  const viewReady = page.waitForResponse(
    (r) => /\/agent\/runs\/run-timeline-big$/.test(r.url()) && r.status() === 200,
  );
  await page.getByTestId('agent-run').first().click();
  await viewReady;
  await expect(page.getByTestId('agent-timeline')).toBeVisible();
}

test.describe('agent workbench — incremental timeline expansion', () => {
  test.beforeEach(async () => {
    await resetAgentFixtures();
  });

  test('collapses adjacent repeats, then reveals the stream in 50-event steps and resets on collapse', async ({
    page,
  }) => {
    await login(page);
    await seedRunWithLongTimeline();
    await openRunHydrated(page);

    const timeline = page.getByTestId('agent-timeline');
    const rows = () => page.getByTestId('agent-event');
    const toggle = page.getByTestId('agent-timeline-toggle');
    const expandMore = page.getByTestId('agent-timeline-expand-more');
    const expandedAll = page.getByTestId('agent-timeline-expanded-all');

    // 1. 折叠态：validate / start / rescan×56 / candidates_ready / generated = 5 行
    await expect(rows()).toHaveCount(5);
    // 折叠行必须如实标注折叠了多少条（56）
    await expect(timeline).toContainText('56');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');

    // 2. 首次展开：head 10 条折成 3 行（validate/start/rescan×8）+ tail 50 单条 = 53 行
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(rows()).toHaveCount(53);
    await expect(expandMore).toBeVisible();
    await expect(expandMore).toContainText(String(TOTAL_EVENTS - EXPAND_STEP)); // 剩余 10
    await expect(expandedAll).toHaveCount(0);

    // 3. 再点增量：60 条全摊开，到底提示出现、增量按钮消失
    await expandMore.click();
    await expect(rows()).toHaveCount(TOTAL_EVENTS);
    await expect(expandedAll).toBeVisible();
    await expect(expandMore).toHaveCount(0);

    // 4. 收起：回到 5 行；再次展开仍只摊 50（证明计数被重置，不是停在 60）
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(rows()).toHaveCount(5);
    await toggle.click();
    await expect(rows()).toHaveCount(53);
    await expect(expandMore).toBeVisible();
  });
});
