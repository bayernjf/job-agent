import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';

/**
 * 求职工作台「真全栈」E2E 配置（2026-10-03）。
 *
 * 与 `playwright.config.ts`（报告页 E2E，**mock 掉全部 API**）刻意分开：
 * 这一套**不 mock**——真 Chromium → 真 `apps/api`（真 Hono + 真 SQLite + 真迁移）→ 真报告页 SSR，
 * 因此它能抓到「前端按契约传了错字段 / 端点按另一个键取值」这类只在真链路上暴露的问题
 * （2026-10-03 的「工作台下载简历 404」就是这样被发现的：票据快照存的是来源原生 jobId，
 * 而 `/resumes/build` 按岗位池主键取行）。
 *
 * 确定性（仓库硬要求：测试默认零网络）：
 * - 夹具岗位由 `e2e/agent/global-setup.ts` 直接写库，**不做 `jobs sync`**，档位/条数可预期；
 * - 会话 token 固定，API 走本地 3101、报告页走本地 4322，两者共用同一个夹具 DB。
 */
const TMP_DIR = resolve(process.cwd(), 'e2e', '.tmp-agent');
const API = 'http://127.0.0.1:3101';
const REPORT = 'http://127.0.0.1:4322';
const RUN_ID = `${process.pid}-${Date.now()}`;

// 每次运行一个**唯一文件名**的库：Playwright 先起 webServer、后跑 globalSetup，
// 而 API 一启动就打开 SQLite（目录不存在会直接崩）；用唯一文件名还能避免上一轮残留的
// API 进程仍持有旧库导致的 EBUSY。旧库只做尽力而为的清理（失败就留着，目录已 gitignore）。
const AGENT_DB = resolve(TMP_DIR, `agent-${RUN_ID}.db`).replace(/\\/g, '/');
// globalSetup 与本配置同一进程：把库路径经 env 传给它，保证两边指向同一个文件
process.env.JA_AGENT_DB = AGENT_DB;
mkdirSync(TMP_DIR, { recursive: true });
try {
  for (const name of readdirSync(TMP_DIR)) {
    if (name.startsWith('agent-') && !name.includes(RUN_ID)) {
      rmSync(resolve(TMP_DIR, name), { recursive: true, force: true });
    }
  }
} catch {
  // 旧库被占用就留着，不影响本轮
}

export default defineConfig({
  testDir: './e2e/agent',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  globalSetup: './e2e/agent/global-setup.ts',
  use: {
    baseURL: REPORT,
    trace: 'on-first-retry',
    locale: 'en-US',
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: [
    {
      // 真 API（Hono + SQLite，非 mock）：工作台 /agent/*、/resumes/build 都打它
      command: 'node apps/api/dist/index.js',
      url: `${API}/health`,
      timeout: 120_000,
      reuseExistingServer: false,
      env: {
        DB_DRIVER: 'sqlite',
        DB_PATH: AGENT_DB,
        PORT: '3101',
        // 报告页是 127.0.0.1:4322，跨端口带 Cookie 需要回显具体 Origin + 允许凭证
        CORS_ALLOW_ORIGINS: REPORT,
      },
    },
    {
      // 报告页 dev（SSR 直读同一个夹具 DB；island 经 PUBLIC_API_BASE 打上面那个 API）
      command: 'pnpm --filter @jobagent/report dev --port 4322 --host 127.0.0.1 --no-toolbar',
      url: `${REPORT}/en/`,
      timeout: 120_000,
      reuseExistingServer: false,
      env: {
        DB_DRIVER: 'sqlite',
        DB_PATH: AGENT_DB,
        PUBLIC_API_BASE: API,
        ASTRO_DEV_BACKGROUND: '1',
      },
    },
  ],
});
