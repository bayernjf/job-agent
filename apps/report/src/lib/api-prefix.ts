/**
 * 形态 C 同域挂载的路径前缀处理（2026-09-21 抽为纯函数）：
 *
 * Vercel 单项目里 Hono API 挂在同域 /api/*，而 Hono 路由定义不含 /api 前缀
 * （/health、/analyze、/auth/github/login …），转发前必须剥掉前缀。
 * 抽成纯函数便于用单测钉死边界（此前该正则只内联在 pages/api/[...slug].ts，零直接测试）。
 */
export function stripApiPrefix(pathname: string): string {
  // /api → /，/api/ → /，/api/analyze → /analyze；不带前缀的路径原样返回
  return pathname.replace(/^\/api(?:\/|$)/, '/');
}
