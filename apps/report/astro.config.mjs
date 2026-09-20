// @ts-check
import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import node from '@astrojs/node';
import vercel from '@astrojs/vercel';

// 部署目标自适应：
// - Vercel（构建环境自带 VERCEL=1，或显式 ASTRO_ADAPTER=vercel）：用 Vercel 适配器，
//   SSR 页面与同域 /api/*（Hono，见 src/pages/api/[...slug].ts）一起构建为 Node serverless functions。
// - 本地 / Docker（默认）：Node standalone，pnpm dev / build 产物行为不变。
const isVercel = Boolean(process.env.VERCEL) || process.env.ASTRO_ADAPTER === 'vercel';

// Vercel Pro 函数最长 300s；Hobby 计划会被平台自动钳到 10s（见部署 Runbook 形态 C）。
// 采集在 cron 端点内完成（每分钟一个任务），报告页 SSR 只读，正常都远低于该值。
const VERCEL_MAX_DURATION_SECONDS = 300;

// https://astro.build/config
export default defineConfig({
  integrations: [react()],
  output: 'server',
  adapter: isVercel
    ? vercel({ maxDuration: VERCEL_MAX_DURATION_SECONDS })
    : node({
        mode: 'standalone',
      }),
  server: {
    port: Number(process.env.REPORT_PORT ?? 4321),
    host: true,
  },
  vite: {
    ssr: {
      // better-sqlite3 是原生模块，不打包进 SSR bundle（生产用 PG，本地/Docker 用 SQLite）
      external: ['better-sqlite3'],
    },
  },
});
