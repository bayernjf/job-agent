/**
 * 报告页「投递追踪」回标 + `/my`「待回标」提示 —— 真全栈 E2E（2026-10-05）。
 *
 * 补的是 item127 如实记下的缺口：追踪下拉的**写入**只有 API 集成测试（真 SQLite）与 agent
 * 流程那一条真全栈用例覆盖过；`manual` 来源的行在真浏览器里"点得动吗、落库吗、`/my` 数得对吗"
 * 无人验证。而 `/my` 的计数与"界面上真能标的行"是否一致，正是 item125 栽过的地方
 * （提示数了标不上的行＝对用户撒谎），所以这条不变量钉在真链路上，而不是 mock E2E 里。
 *
 * 与 `workbench-fullstack.spec.ts` 同一套夹具：真 API（3101）+ 真 SQLite + 真报告页 SSR（4322），
 * **不 mock 任何端点**。
 */
import { test, expect, type Page } from '@playwright/test';
import { FIXTURE_PROFILE_ID, default as resetAgentFixtures } from './global-setup';
import { API, authHeaders, login } from './helpers';

const REPORT = `/en/report/${FIXTURE_PROFILE_ID}`;
const MY = '/en/my';

interface AppRow {
  id: string;
  targetTitle: string;
  targetCompany: string;
  status: string;
  origin: string;
  outcomeFeedback: string | null;
  outcomeFeedbackAt: string | null;
}

/** 服务端视角的"待回标"口径，必须与 my.astro 的过滤条件逐字一致。 */
const isPending = (a: AppRow) => a.status === 'applied' && !a.outcomeFeedback;

async function listApplications(page: Page): Promise<AppRow[]> {
  const res = await page.request.get(`${API}/profiles/${FIXTURE_PROFILE_ID}/applications`, {
    headers: authHeaders,
  });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { items: AppRow[] };
  return body.items;
}

/**
 * 打开报告页并等投递追踪岛**水合且首屏数据到位**。
 * 岛是 client:load：SSR 只出"加载中"，水合前 select 还不存在；等自己的 GET 回来
 * 才算可操作（沿用 ResumeBuilder 的教训：早写值会被首帧渲染覆盖）。
 */
async function openTrackerReady(page: Page): Promise<void> {
  const ready = page.waitForResponse(
    (r) => r.url().includes('/applications') && r.request().method() === 'GET' && r.status() === 200,
  );
  await page.goto(REPORT);
  await ready;
}

/**
 * `/my` 的待回标区块：文案里的计数与实际行数。
 * 整段缺席返回 null（渲染条件是 pendingOutcomes.length > 0）。
 */
async function readMyPending(page: Page): Promise<{ hint: number; rows: number } | null> {
  await page.goto(MY);
  const section = page.getByTestId('my-pending-outcomes');
  if ((await section.count()) === 0) return null;
  const text = await section.locator('p').first().innerText();
  const match = /(\d+)\s+submitted application/.exec(text);
  expect(match, `/my 提示里读不到计数：${text}`).not.toBeNull();
  return { hint: Number(match![1]), rows: await section.locator('li').count() };
}

test.describe('application tracker — full stack', () => {
  // 每个用例前幂等重灌（清 applications 等业务表）：本文件依赖"起点没有待标行"
  test.beforeEach(async () => {
    await resetAgentFixtures();
  });

  test('an application added in the browser can be marked, and /my counts it exactly while it is unmarked', async ({
    page,
  }) => {
    await login(page);

    // 起点：库里确实没有待标行，提示段也就不该存在（少了这一步，后面的计数可能恒真）
    expect(await listApplications(page)).toHaveLength(0);
    expect(await readMyPending(page)).toBeNull();

    // 真 UI 建一条手工投递（origin 由服务端默认给 manual，前端不传）
    const created = page.waitForResponse(
      (r) => r.url().includes('/applications') && r.request().method() === 'POST',
    );
    await openTrackerReady(page);
    await page.getByRole('button', { name: 'Add application' }).click();
    await page.fill('#apptrk-company', 'Fixture GmbH');
    await page.fill('#apptrk-role', 'Platform Engineer');
    await page.locator('.apptrk-form button[type=submit]').click();
    const createRes = await created;
    expect(createRes.status()).toBe(201);
    const row = (await createRes.json()) as AppRow;
    expect(row.origin).toBe('manual');
    expect(row.outcomeFeedback).toBeNull();

    // 落库与界面一致
    expect(await listApplications(page)).toHaveLength(1);
    const outcome = page.getByTestId(`apptrk-outcome-${row.id}`);
    await expect(outcome).toHaveValue('');

    // `/my` 此刻必须数到它——提示数不到可标的行，和数到标不上的行，是同一类谎言。
    // 三处口径（提示文案数字 / 列表行数 / 服务端待标行数）必须同时对齐。
    expect(await readMyPending(page)).toEqual({ hint: 1, rows: 1 });
    expect((await listApplications(page)).filter(isPending)).toHaveLength(1);
    await expect(page.getByTestId('my-pending-outcomes')).toContainText('Fixture GmbH');
    await expect(
      page.getByRole('link', { name: 'Record it on that profile' }),
    ).toHaveAttribute('href', REPORT);

    // 回标：走 PATCH /applications/:id（item126 新开的写口）
    await openTrackerReady(page);
    const patched = page.waitForResponse(
      (r) => r.url().includes(`/applications/${row.id}`) && r.request().method() === 'PATCH',
    );
    await expect(outcome).toHaveValue('');
    await outcome.selectOption('rejected');
    expect((await patched).status()).toBe(200);

    // 重新加载后仍是该值：值来自库，不是组件本地状态
    await page.reload();
    await expect(outcome).toHaveValue('rejected');
    const [stored] = await listApplications(page);
    expect(stored?.outcomeFeedback).toBe('rejected');
    expect(stored?.outcomeFeedbackAt).toBeTruthy();

    // 标完之后提示必须整段消失（计数承重，不是常驻文案）
    expect(await readMyPending(page)).toBeNull();
  });

  test('a client-supplied outcome timestamp is ignored, and the tracker renders what another surface wrote', async ({
    page,
  }) => {
    await login(page);

    // 另一条写口（非浏览器）建行并回标，同时**试图自填"何时知道结果"**
    const created = await page.request.post(`${API}/profiles/${FIXTURE_PROFILE_ID}/applications`, {
      headers: { ...authHeaders, 'content-type': 'application/json' },
      data: { targetCompany: 'Written Elsewhere', targetTitle: 'Backend Engineer' },
    });
    expect(created.status()).toBe(201);
    const row = (await created.json()) as AppRow;

    const patched = await page.request.patch(`${API}/applications/${row.id}`, {
      headers: { ...authHeaders, 'content-type': 'application/json' },
      data: { outcomeFeedback: 'offer', outcomeFeedbackAt: '2020-01-01T00:00:00.000Z' },
    });
    expect(patched.status()).toBe(200);
    const stored = (await patched.json()) as AppRow;

    // 时间戳由服务端盖：自填的 2020 不生效（否则"何时知道结果"这个维度可被伪造）
    expect(stored.outcomeFeedback).toBe('offer');
    expect(stored.outcomeFeedbackAt).not.toBe('2020-01-01T00:00:00.000Z');
    expect(Math.abs(Date.now() - Date.parse(stored.outcomeFeedbackAt ?? ''))).toBeLessThan(
      5 * 60 * 1000,
    );

    // 界面读得到别的写口标的值：同一个字段、同一套值域，两处分写不漂移
    await openTrackerReady(page);
    const outcome = page.getByTestId(`apptrk-outcome-${row.id}`);
    await expect(outcome).toHaveValue('offer');

    // 如实钉住当前边界：标过之后界面上没有"退回未记录"的选项（清除流程至今未开放，见 handoff）
    await expect(outcome.getByRole('option', { name: 'Not recorded' })).toHaveCount(0);
    await expect(outcome.locator('option')).toHaveCount(4);
  });
});
