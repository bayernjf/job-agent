/**
 * 出站代理引导（仅服务端发起的请求）。
 *
 * GitHub OAuth 回调里需要用 Node 全局 fetch 向 github.com 交换 access token、
 * 拉取用户资料。Node 的全局 fetch（undici）默认不读 HTTP_PROXY/HTTPS_PROXY，
 * 在直连 GitHub 受限的网络（如本地开发需走 Clash 等代理）会直接 fetch failed。
 * 这里在进程启动时按环境变量显式安装一个全局 undici ProxyAgent；未配置代理时
 * 完全不改变默认行为（生产直连或在反代/出口层处理）。
 *
 * 优先级与 CLI（apps/cli/src/jobs-commands.ts）保持一致：
 *   JOB_HTTP_PROXY > HTTPS_PROXY > HTTP_PROXY（含小写）。
 */
import { ProxyAgent, setGlobalDispatcher } from 'undici';

export function resolveOutboundProxy(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw =
    env.JOB_HTTP_PROXY ?? env.HTTPS_PROXY ?? env.HTTP_PROXY ?? env.https_proxy ?? env.http_proxy;
  const value = raw?.trim();
  return value ? value : undefined;
}

/**
 * 若配置了出站代理则安装全局 dispatcher，返回生效的代理 URL；否则返回 undefined。
 * 进程内只需调用一次（API 入口 main() 启动时）。
 */
export function configureOutboundProxy(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const proxyUrl = resolveOutboundProxy(env);
  if (proxyUrl) {
    setGlobalDispatcher(new ProxyAgent(proxyUrl));
  }
  return proxyUrl;
}
