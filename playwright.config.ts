import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';

/**
 * Playwright E2E 配置（#1）。
 *
 * - globalSetup 预置一个含 fixture 画像的临时 SQLite（报告页 SSR 有数据）。
 * - webServer 自动拉起 Astro report（SSR），DB_PATH 指向 fixture DB。
 * - 前端主链路（输入→/analyze→轮询→跳转）通过 page.route mock API，
 *   不依赖真实 API/Worker/GitHub，保证确定性。
 * - 只跑 Chromium；CI 可用 `pnpm e2e` 触发。
 */
const FIXTURE_DB = resolve(process.cwd(), 'e2e', '.tmp', 'e2e.db').replace(/\\/g, '/');

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.ts',
  // 扩展用例归属 playwright.extension.config.ts（其 fixture 自启 persistent context
  // 加载 unpacked MV3，不需要这里的 Astro webServer / fixture DB）；显式排除，
  // 避免 `pnpm e2e` 与 `pnpm e2e:extension` 重复执行同一批扩展用例。
  testIgnore: '**/extension/**',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  timeout: 30000,
  expect: { timeout: 7000 },
  globalSetup: './e2e/global-setup.ts',
  use: {
    baseURL: 'http://localhost:4321',
    trace: 'on-first-retry',
    locale: 'en-US',
  },
  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium' },
    },
  ],
  webServer: {
    // dev 模式即 SSR，免去每次 build；固定端口。
    // --no-toolbar：关闭 Astro Dev Toolbar，其 island inspector 会在 shadow DOM
    // 里以 <code> 渲染各 island 的 props（含全部 i18n 文案），会干扰文本定位。
    command: 'pnpm --filter @jobagent/report dev --port 4321 --host 127.0.0.1 --no-toolbar',
    url: 'http://127.0.0.1:4321/en/',
    timeout: 120000,
    reuseExistingServer: false,
    env: {
      DB_DRIVER: 'sqlite',
      DB_PATH: FIXTURE_DB,
    },
  },
});
