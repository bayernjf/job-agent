/**
 * 浏览器侧（客户端 island）访问后端 API 的基址解析：
 *
 * 1. 显式配置 PUBLIC_API_BASE 时优先用它（本地/Docker 跨端口、或跨域部署）；
 * 2. Vercel 同域部署（VERCEL=1）时 API 挂在同域 /api（见 src/pages/api/[...slug].ts）；
 * 3. 本地 Node standalone 形态默认同源相对路径 ''（dev 代理或独立 API 服务器按需配置）。
 *
 * 注意：SSR 直读 storage 的页面不经过该基址；它只用于客户端 fetch（创建分析、投递、认证等）。
 * 本文件是被 .astro frontmatter 引用的纯 .ts（不在 vite/client 类型工程内），
 * 故对 import.meta.env 做最小化显式转换，运行期仍由 Astro/Vite 静态替换 PUBLIC_* 变量。
 */
export function browserApiBase(): string {
  const importMetaEnv = (import.meta as unknown as { env?: Record<string, string | undefined> })
    .env;
  const explicit = importMetaEnv?.PUBLIC_API_BASE;
  if (typeof explicit === 'string' && explicit.trim() !== '') {
    return explicit.trim();
  }
  if (process.env.VERCEL) {
    return '/api';
  }
  return '';
}
