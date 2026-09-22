import { defineConfig } from '@playwright/test';

/**
 * 浏览器扩展 E2E 配置（design-extension-e2e-20260914.md）。
 *
 * 与 playwright.config.ts（report）刻意分离：扩展用 launchPersistentContext
 * 加载 unpacked MV3，不需要 Astro webServer / fixture DB，也不用内置 browser fixture。
 * - 无 webServer：ATS 页与 API 全部由 e2e/extension/extension-test.ts 的 route 拦截。
 * - workers:1 / fullyParallel:false：每个用例独立临时 user-data-dir 与扩展实例，串行更稳。
 * - 无头靠 --headless=new（在 fixture 的 launch args 内），无需 xvfb。
 * 运行前需已构建 apps/extension/dist（e2e:extension 脚本会先 build）。
 */
export default defineConfig({
  testDir: './e2e/extension',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  // headless=new 冷启动 + 解压加载 unpacked MV3 在前几个用例较重（机器繁忙时 setup 可超 30s），
  // 给单测 60s 裕量；断言超时仍保持 7s 不变。
  timeout: 60_000,
  expect: { timeout: 7_000 },
  use: {
    locale: 'en-US',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium' },
    },
  ],
});
