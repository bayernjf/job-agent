/**
 * 同域挂载 Hono API（serverless 形态，2026-09-20）：
 *
 * Vercel 单项目里报告页（Astro SSR）与后端（Hono）同域部署：
 *   - 页面：/、/zh-CN/report/:id、/zh-CN/recruit ...
 *   - API：/api/*（本 catch-all 转发到 @jobagent/api 的 createApp()）
 *
 * Hono 路由定义不含 /api 前缀（如 /health、/analyze、/auth/github/login），
 * 故转发前剥掉路径里的 /api 前缀。同域后浏览器侧 API 基址就是 '/api'（见 lib/api-base.ts），
 * cookie/CORS 最简：SSR 页面与 API 同源，无需跨子域凭证。
 *
 * 本地 / Docker 形态不走本文件：API 由 apps/api 的 Node 服务器独立监听，
 * 报告页通过 PUBLIC_API_BASE 指向它（见部署 Runbook 形态 A/B）。
 */
import type { APIRoute } from 'astro';
import { forwardToHono } from '../../lib/internal-api';

// ALL 覆盖 GET/POST/PATCH/OPTIONS（含 CORS 预检，由 Hono cors 中间件处理）
export const ALL: APIRoute = ({ request }) => forwardToHono(request);
