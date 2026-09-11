// @ts-check
import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import node from '@astrojs/node';

// JobAgent 报告页（M1·W4）
// SSR 模式：报告页从数据库/API 获取画像快照，服务端渲染保证分享链接可访问。
// React islands：客户端交互（语言切换、证据展开、任务轮询）。
export default defineConfig({
  integrations: [react()],
  output: 'server',
  adapter: node({
    mode: 'standalone',
  }),
  server: {
    port: Number(process.env.REPORT_PORT ?? 4321),
    host: true,
  },
  vite: {
    // better-sqlite3 是原生模块，不打包
    ssr: {
      external: ['better-sqlite3'],
    },
  },
});
