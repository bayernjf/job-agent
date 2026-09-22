/**
 * 扩展 E2E 自定义 fixture：加载 unpacked MV3 扩展的 persistent context，
 * 统一拦截 ATS 模拟页与 JobAgent API（零网络、零 dev server），并暴露
 * extPage / openPanel / setMatchResponder。
 *
 * 技术要点见 docs/design-extension-e2e-20260914.md：
 * - launchPersistentContext + --headless=new 才能在无头下加载扩展；
 * - open shadow DOM 由 Playwright locator 自动穿透；
 * - /analyze 直接回 profileId 走缓存短路，跳过轮询。
 */
import { test as base, chromium, type Page } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toExportableProfile } from '@jobagent/shared';
import { buildFixtureProfile, FIXTURE_PROFILE_ID } from '../fixtures/sample-profile.js';
import { ATS_HTML, ATS_PAGE_URL, THREE_TIER_MATCHES } from './fixtures.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const EXT_DIST = path.resolve(here, '../../apps/extension/dist');

interface MatchReply {
  status: number;
  body: unknown;
}

interface Harness {
  page: Page;
  setMatchResponder: (fn: (callCount: number) => MatchReply) => void;
  /** 最近一次 POST /analyze 的请求体（在 context 级路由捕获，含 service worker 发出的请求）。 */
  lastAnalyzeBody: () => unknown;
  openPanel: () => Promise<void>;
}

/**
 * 单一内部 fixture 持有 persistent context、路由与可变 match 响应器，
 * 其余三个对外 fixture 都从它派生，避免状态分散在多个 fixture 闭包。
 */
interface ExtensionFixtures {
  _harness: Harness;
  extPage: Page;
  openPanel: () => Promise<void>;
  setMatchResponder: (fn: (callCount: number) => MatchReply) => void;
  lastAnalyzeBody: () => unknown;
}

export const test = base.extend<ExtensionFixtures>({
  // eslint-disable-next-line no-empty-pattern
  _harness: async ({}, use) => {
    const userDataDir = await mkdtemp(path.join(tmpdir(), 'ja-ext-e2e-'));
    const headed = process.env.HEADED === '1';
    const context = await chromium.launchPersistentContext(userDataDir, {
      // 扩展需 headless:false 标志位 + args 传 --headless=new 才能在无头加载（设计文档 §2）。
      headless: false,
      args: [
        `--disable-extensions-except=${EXT_DIST}`,
        `--load-extension=${EXT_DIST}`,
        ...(headed ? [] : ['--headless=new']),
      ],
    });

    // match 响应器：默认三档列表，用例可覆盖；handler 始终读最新引用。
    const state: {
      responder: (n: number) => MatchReply;
      calls: number;
      analyzeBody: unknown;
    } = {
      responder: () => ({ status: 200, body: THREE_TIER_MATCHES }),
      calls: 0,
      analyzeBody: null,
    };

    // /analyze 由 context 级路由拦截（content script 经 service worker 代发，
    // page 级 route 拦不到 SW 请求）；记录请求体供平台切换等用例断言。
    await context.route('**/analyze', (route) => {
      try {
        state.analyzeBody = JSON.parse(route.request().postData() ?? '{}');
      } catch {
        state.analyzeBody = null;
      }
      return route.fulfill({ json: { profileId: FIXTURE_PROFILE_ID } });
    });
    await context.route('**/profiles/*/exportable', (route) =>
      route.fulfill({ json: toExportableProfile(buildFixtureProfile()) }),
    );
    await context.route('**/job-postings/match', (route) => {
      const reply = state.responder(state.calls++);
      return route.fulfill({
        status: reply.status,
        contentType: 'application/json',
        body: JSON.stringify(reply.body),
      });
    });
    await context.route(ATS_PAGE_URL, (route) =>
      route.fulfill({ contentType: 'text/html', body: ATS_HTML }),
    );

    const page = await context.newPage();
    await page.goto(ATS_PAGE_URL, { waitUntil: 'domcontentloaded' });
    // content script 在 document_idle 注入，等悬浮按钮出现即扩展就绪。
    await page.locator('.ja-fab').waitFor({ timeout: 10_000 });

    const harness: Harness = {
      page,
      setMatchResponder(fn) {
        state.responder = fn;
        state.calls = 0;
      },
      lastAnalyzeBody() {
        return state.analyzeBody;
      },
      async openPanel() {
        const fab = page.locator('.ja-fab');
        const panel = page.locator('#jobagent-autofill-panel');
        if ((await panel.count()) === 0 || !(await panel.isVisible())) {
          await fab.click();
        }
        await panel.waitFor({ state: 'visible', timeout: 5000 });
      },
    };

    await use(harness);

    await context.close();
    await rm(userDataDir, { recursive: true, force: true });
  },

  extPage: async ({ _harness }, use) => use(_harness.page),
  openPanel: async ({ _harness }, use) => use(_harness.openPanel),
  setMatchResponder: async ({ _harness }, use) => use(_harness.setMatchResponder),
  lastAnalyzeBody: async ({ _harness }, use) => use(_harness.lastAnalyzeBody),
});

export { expect } from '@playwright/test';
