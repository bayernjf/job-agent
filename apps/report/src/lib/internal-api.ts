/**
 * 同域挂载 Hono API 的服务端单例（serverless 形态，2026-09-20）：
 *
 * pages/api/[...slug].ts 把 /api/* 剥前缀后交给 @jobagent/api 的 createApp()。
 * 函数实例内复用单例（温实例避免每次调用重建 Hono 路由与存储连接池）。
 *
 * 注意：纯 SSR 表单动作（如 F10 招聘方声明）**不**走这里的 createApp()——
 * standalone/preview 下它会触发 API 的生产启动闸（CRON_SECRET/TRUST_PROXY），
 * 且报告页架构是「SSR 直读/直写 storage，不走 API」（见 lib/auth.ts 与
 * recruit/declare.ts）。
 */
import { createApp } from '@jobagent/api';
import { stripApiPrefix } from './api-prefix';

type JobAgentApp = Awaited<ReturnType<typeof createApp>>;

let appPromise: Promise<JobAgentApp> | null = null;

export function getInternalApp(): Promise<JobAgentApp> {
  if (!appPromise) {
    appPromise = createApp();
  }
  return appPromise;
}

/** 把请求改写为 Hono 期望的路径后交给 Hono，返回标准 Web Response。 */
export async function forwardToHono(request: Request): Promise<Response> {
  const app = await getInternalApp();
  const url = new URL(request.url);
  url.pathname = stripApiPrefix(url.pathname);
  return app.fetch(new Request(url, request));
}
