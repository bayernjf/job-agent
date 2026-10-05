/**
 * 求职工作台「真全栈」E2E（2026-10-03）：真 Chromium → 真 API → 真 SQLite → 真报告页 SSR。
 *
 * 覆盖设计 §6 阶段 1 的判据（"打开页面，10 个匹配岗位 + 简历都备好了"）与三条硬边界：
 * 只准备不投递 / 匹配报告只认 code / 限频整批拒绝（限频由 API 单测覆盖，这里覆盖链路）。
 *
 * 其中「下载简历」一条是**回归用例**：票据快照必须带岗位池主键（`job.postingId`），
 * 否则 `POST /resumes/build` 会 404（2026-10-03 真浏览器点测发现的缺陷）。
 */
import { statSync } from 'node:fs';
import { test, expect, type Page } from '@playwright/test';
import {
  FIXTURE_PROFILE_ID,
  default as resetAgentFixtures,
} from './global-setup';
import { API, authHeaders, login } from './helpers';

const WORKBENCH = '/en/workbench';

/**
 * 打开工作台并**等水合完成**。
 * island 是 client:load：SSR 先出 HTML，React 水合前点击会被丢掉（点了没反应），
 * 而水合完成的可靠信号是岛内首次数据请求（GET /agent/runs）回来了。
 */
async function openWorkbenchHydrated(page: Page): Promise<void> {
  const runsReady = page.waitForResponse(
    (r) => r.url().includes('/agent/runs') && r.request().method() === 'GET' && r.status() === 200,
  );
  await page.goto(WORKBENCH);
  await expect(page.getByTestId('agent-workbench')).toBeVisible();
  await runsReady;
}

/** 走真 UI 建一套偏好 + 建任务并等首轮扫描落地。 */
async function createPreferenceAndRun(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'New preference' }).click();
  await expect(page.locator('#agent-pref-label')).toBeVisible();
  await page.fill('#agent-pref-label', 'E2E · TypeScript');
  await page.fill('#agent-pref-titles', 'typescript, engineer');
  await page.fill('#agent-pref-skills', 'TypeScript, Astro, React');
  await page.getByRole('button', { name: 'Create preference' }).click();
  await expect(page.getByTestId('agent-pref').first()).toBeVisible();

  const profileOptions = await page.locator('#agent-run-profile option').allInnerTexts();
  const prefOptions = await page.locator('#agent-run-preference option').allInnerTexts();
  await page.selectOption('#agent-run-profile', { index: profileOptions.length > 1 ? 1 : 0 });
  await page.selectOption('#agent-run-preference', { index: prefOptions.length > 1 ? 1 : 0 });
  await page.getByRole('button', { name: 'New run' }).click();
  await expect(page.getByTestId('agent-run').first()).toBeVisible();
}

test.describe('agent workbench — full stack', () => {
  // 用例间隔离：每个用例前幂等重灌夹具（DELETE 业务表 + 重灌，不重建库文件，
  // 对运行中的 API/report 连接安全）。否则 stage-1 已 approve/submit/reject 的票据与
  // 已投递岗位会跨 run 污染 stage-2（agent-runner 排除已投递岗位、pending-fills 跨 run 累积）。
  test.beforeEach(async () => {
    await resetAgentFixtures();
  });

  test('anonymous visitors get the login gate with a same-origin return link', async ({ page }) => {
    await page.goto(WORKBENCH);
    const gate = page.getByTestId('workbench-gate');
    await expect(gate).toBeVisible();
    const href = await gate.getByTestId('gate-login').getAttribute('href');
    expect(href).toContain('/auth/github/login');
    expect(href).toContain(`return_to=${encodeURIComponent('/en/workbench')}`);
  });

  test('runs the whole stage-1 loop against the real API (preference → run → tickets → artifacts → human gate)', async ({
    page,
  }) => {
    const consoleErrors: string[] = [];
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(m.text());
    });

    await login(page);
    await openWorkbenchHydrated(page);

    await createPreferenceAndRun(page);

    // 状态机：四步迁移全部落审计事件（本地化文案，非内部码）
    await expect(page.getByTestId('agent-run-detail')).toContainText('Awaiting your approval');
    const timeline = page.getByTestId('agent-event');
    await expect(timeline).toHaveCount(4);
    await expect(timeline.first()).toContainText('Validated preference and profile');
    await expect(page.getByTestId('agent-timeline')).toContainText('Reports and materials generated');

    // 待投清单：夹具岗位 3 条过闸（1 high + 2 mid），营销岗被偏好关键词挡掉
    const intents = page.getByTestId('agent-intent');
    await expect(intents).toHaveCount(3);
    const tiers = await page.getByTestId('agent-intent-tier').allInnerTexts();
    expect(tiers.sort()).toEqual(['Fair match', 'Fair match', 'Strong match'].sort());
    // 匹配报告只渲染 code 现拼的句子，绝不把内核码印出来
    const first = intents.first();
    await expect(first).toContainText('TypeScript');
    await expect(first).not.toContainText('tag_match');
    await expect(first).not.toContainText('tag_not_in_profile');

    // 回归：简历下载必须 200（票据快照带岗位池主键），且落地为 md 文件
    const [resumeResponse] = await Promise.all([
      page.waitForResponse((r) => r.url().includes('/resumes/build') && r.request().method() === 'POST'),
      (async () => {
        const [download] = await Promise.all([
          page.waitForEvent('download'),
          first.getByRole('button', { name: 'Download resume md' }).click(),
        ]);
        const path = await download.path();
        expect(download.suggestedFilename()).toMatch(/\.md$/);
        expect(statSync(path!).size).toBeGreaterThan(200);
      })(),
    ]);
    expect(resumeResponse.status()).toBe(200);

    // 求职信走 agent 自己的导出端点（票据快照装配）
    const [coverResponse] = await Promise.all([
      page.waitForResponse((r) => r.url().includes('/cover-letter')),
      (async () => {
        const [download] = await Promise.all([
          page.waitForEvent('download'),
          first.getByRole('button', { name: 'Download cover letter md' }).click(),
        ]);
        expect(statSync((await download.path())!).size).toBeGreaterThan(100);
      })(),
    ]);
    expect(coverResponse.status()).toBe(200);

    // 人机闸：确认只置票据、把"投递"留给用户；拒绝带原因
    await first.getByRole('button', { name: 'Approve' }).click();
    await expect(page.getByTestId('agent-approved-note')).toContainText('Please submit them on the job pages yourself');
    const second = intents.nth(1);
    await second.locator('input').fill('e2e: not my direction');
    await second.getByRole('button', { name: 'Reject' }).click();
    await expect(timeline).toHaveCount(5);

    // 「跟」：标记已投 → 真 API 写出一条 origin=agent 的投递记录（可被既有跟踪管道消费）
    await first.getByRole('button', { name: 'Mark submitted' }).click();
    await expect
      .poll(async () => {
        const res = await page.request.get(`${API}/profiles/${FIXTURE_PROFILE_ID}/applications`, {
          headers: authHeaders,
        });
        if (res.status() !== 200) return `status ${res.status()}`;
        const body = (await res.json()) as { items: Array<{ origin: string; submitIntentId: string | null }> };
        return `${body.items.length}:${body.items[0]?.origin}:${body.items[0]?.submitIntentId ? 'linked' : 'unlinked'}`;
      }, { timeout: 20_000 })
      .toBe('1:agent:linked');

    // 「复盘」：已投清单必须能就地回标并读回——D1 的写端点此前没有任何界面入口
    const submissions = page.getByTestId('agent-submissions');
    const submissionRow = page.getByTestId('agent-submission').first();
    await expect(submissionRow).toBeVisible({ timeout: 20_000 });
    await expect(submissions.getByTestId('agent-outcome-saved')).toHaveCount(0);
    await submissionRow.locator('select').selectOption('interview');
    await expect(submissions.getByTestId('agent-outcome-saved')).toHaveCount(1);
    // 重新加载后仍是该值：证明写进了库，不是组件本地状态
    await page.reload();
    await expect(
      page.getByTestId('agent-submission').first().locator('select'),
    ).toHaveValue('interview', { timeout: 20_000 });

    // 真链路不应有控制台报错（曾经那条 404 就出现在这里）
    expect(consoleErrors).toEqual([]);
  });

  test('stage-2 extension contract: pending-fills → tailored cover letter (with AI disclosure) → submitted receipt → outcome write-back', async ({
    page,
  }) => {
    await login(page);
    await openWorkbenchHydrated(page);
    await createPreferenceAndRun(page);

    // 人机闸：在工作台确认第一条（模拟用户在报告页/工作台批准），其余保持 pending。
    // beforeEach 已重灌夹具，本 run 是该账号首个 run，3 条过闸岗位全部进待投清单。
    const intents = page.getByTestId('agent-intent');
    await expect(intents).toHaveCount(3);
    await intents.first().getByRole('button', { name: 'Approve' }).click();
    await expect(page.getByTestId('agent-approved-note')).toBeVisible();

    // A2：扩展在 ATS 页面拉取「跨 run、已确认、待填充」票据，只拿到刚批准的一条
    const fillsRes = await page.request.get(`${API}/agent/extension/pending-fills`, { headers: authHeaders });
    expect(fillsRes.status()).toBe(200);
    const fillsBody = (await fillsRes.json()) as {
      fills: Array<{ intentId: string; profileId: string; job: { sourceUrl: string }; matchScore: number; approvedAt: string }>;
    };
    expect(fillsBody.fills).toHaveLength(1);
    const fill = fillsBody.fills[0];
    expect(fill.intentId).toBeTruthy();
    expect(fill.profileId).toBe(FIXTURE_PROFILE_ID);
    expect(fill.job.sourceUrl).toMatch(/^https?:\/\//);
    expect(typeof fill.matchScore).toBe('number');
    expect(fill.approvedAt).toBeTruthy();

    // C2 + E1：岗位定向求职信 JSON（polish=llm）。CI 无 LLM key → fail-closed 回落规则版，
    // body 仍必须以招聘方可见的 AI 辅助披露行收尾。
    const clRes = await page.request.get(
      `${API}/agent/intents/${fill.intentId}/cover-letter?format=json&polish=llm&locale=en`,
      { headers: authHeaders },
    );
    expect(clRes.status()).toBe(200);
    const cl = (await clRes.json()) as { body: string; polished: boolean; fallbackReason?: string; subject: string | null };
    expect(cl.body.length).toBeGreaterThan(100);
    expect(cl.body).toContain('prepared with AI assistance by JobAgent');
    expect(cl.polished).toBe(false);
    expect(cl.fallbackReason).toBe('llm_unavailable');

    // A2 收尾：用户在 ATS 自行提交后点「我已提交」→ 幂等写 origin=agent 投递记录
    const msRes = await page.request.post(`${API}/agent/intents/${fill.intentId}/mark-submitted`, {
      headers: { ...authHeaders, 'content-type': 'application/json' },
    });
    expect(msRes.status()).toBe(200);
    const ms = (await msRes.json()) as { applicationId: string | null };
    expect(ms.applicationId).toBeTruthy();

    // 已提交的票据立即从待填充列表消失（只保留 approved）
    const fillsAfter = await page.request.get(`${API}/agent/extension/pending-fills`, { headers: authHeaders });
    const fillsAfterBody = (await fillsAfter.json()) as { fills: Array<{ intentId: string }> };
    expect(fillsAfterBody.fills.map((f) => f.intentId)).not.toContain(fill.intentId);

    // D1：投递结果回写（邀约面试）→ applications 反映复盘枚举
    const ocRes = await page.request.post(`${API}/agent/intents/${fill.intentId}/outcome`, {
      headers: { ...authHeaders, 'content-type': 'application/json' },
      data: { outcome: 'interview' },
    });
    expect(ocRes.status()).toBe(200);
    const oc = (await ocRes.json()) as { outcomeFeedback: string; outcomeFeedbackAt: string };
    expect(oc.outcomeFeedback).toBe('interview');
    expect(oc.outcomeFeedbackAt).toBeTruthy();

    // 非法枚举被 Zod 拒绝（400），不污染复盘样本
    const bad = await page.request.post(`${API}/agent/intents/${fill.intentId}/outcome`, {
      headers: { ...authHeaders, 'content-type': 'application/json' },
      data: { outcome: 'not_a_real_outcome' },
    });
    expect(bad.status()).toBe(400);

    const appsRes = await page.request.get(`${API}/profiles/${FIXTURE_PROFILE_ID}/applications`, {
      headers: authHeaders,
    });
    const apps = (await appsRes.json()) as {
      items: Array<{ origin: string; outcomeFeedback: string | null; submitIntentId: string | null }>;
    };
    const linked = apps.items.find((a) => a.submitIntentId === fill.intentId);
    expect(linked).toBeTruthy();
    expect(linked?.origin).toBe('agent');
    expect(linked?.outcomeFeedback).toBe('interview');
  });
});
