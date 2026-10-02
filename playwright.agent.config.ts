import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';
import agentGlobalSetup from './e2e/agent/global-setup.ts';

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

// 与 e2e/agent/global-setup.ts 的 AGENT_DB 保持**同一固定路径**（确定性硬要求）：
// globalSetup 在 Playwright 独立进程中运行，跨进程传路径只靠 env 继承（实测不可靠——
// 曾出现 globalSetup 回退到自身 pid-ts 文件、与 webServer 各用一库，导致
// "导航已登录、页面恒登录墙"）。固定文件名消除该不确定性；配置加载期先清残留，
// API/report/webServer 与 globalSetup 全部指向同一个文件。
const AGENT_DB = resolve(TMP_DIR, 'agent-e2e.db').replace(/\\/g, '/');
// globalSetup 与本配置同一进程：把库路径经 env 传给它（若继承失效，两边也有相同 fallback）
process.env.JA_AGENT_DB = AGENT_DB;
mkdirSync(TMP_DIR, { recursive: true });
try {
  for (const name of readdirSync(TMP_DIR)) {
    // 只清带 RUN_ID 后缀的临时库（旧方案残留）；固定名 agent-e2e.db 不清——
    // 删除它会替换已打开进程连接的底层文件（SQLITE_READONLY_DBMOVED / 空库缓存）。
    if (name.startsWith('agent-') && name.includes(RUN_ID)) {
      rmSync(resolve(TMP_DIR, name), { recursive: true, force: true });
    }
  }
} catch {
  // 旧库被占用就留着，不影响本轮
}

// 配置加载期**幂等灌入夹具数据**（不删库文件、不重建 schema）：
// - Playwright 会多次 import 配置模块（顶层 await 会多次执行），若这里删库重建，
//   会替换 webServer 进程（API/report）已打开连接的底层文件 → SQLITE_READONLY_DBMOVED
//   （API 写库即 500）或 readonly 连接缓存空库（恒登录墙）。agentGlobalSetup 已按
//   「清空业务表 → 迁移（幂等）→ 灌夹具」实现，对多次执行安全。
// - webServer 启动前数据即就位，任何进程打开库文件时都完整可用。
await agentGlobalSetup();

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
  // 注意：不再注册 Playwright globalSetup——夹具数据已在配置加载期（webServer 启动前）
  // 由 agentGlobalSetup() 灌入，若这里再注册同名函数会在 webServer 之后重复 insert 撞 UNIQUE。
  // globalSetup: './e2e/agent/global-setup.ts',
  use: {
    baseURL: REPORT,
    trace: 'on-first-retry',
    locale: 'en-US',
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: [
    {
      // 真 API（Hono + SQLite，非 mock）：工作台 /agent/*、/resumes/build 都打它。
      // 夹具库已在配置加载期由 agentGlobalSetup() 幂等灌好（见上方注释），API 直接打开同一文件。
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
      stdout: 'pipe',
      stderr: 'pipe',
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
