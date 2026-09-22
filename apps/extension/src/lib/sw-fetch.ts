/**
 * content script 侧的 fetch 适配器：把请求经 chrome.runtime.sendMessage 转发给
 * background service worker 代发（见 sw-relay.ts 的为什么）。
 *
 * 对外暴露与全局 fetch 兼容的最小表面（lib/api.ts 只使用 ok/status/statusText/json()/text()），
 * 这样 JobAgentApi / matchJobs 无需感知传输通道，单测仍可注入假 fetch。
 */
import {
  EXT_MSG_API_REQUEST,
  type ApiRequestMessage,
  type ApiResponseMessage,
} from './sw-relay.js';

/** 把 fetch 的 HeadersInit 归一化为普通对象（结构化克隆可传递）。 */
function normalizeHeaders(headers?: HeadersInit): Record<string, string> | undefined {
  if (!headers) return undefined;
  if (typeof Headers !== 'undefined' && headers instanceof Headers) {
    return Object.fromEntries(headers.entries());
  }
  if (Array.isArray(headers)) {
    return Object.fromEntries(headers);
  }
  return { ...(headers as Record<string, string>) };
}

/**
 * 与 typeof fetch 同形的代发函数。请求在扩展源（SW）执行，规避页面源的
 * CORS / 混合内容 / 私有网络访问限制；SW 不可用或网络失败时抛 TypeError，
 * 与原生 fetch 失败时面板看到的 “Failed to fetch” 行为一致。
 */
export const swFetch: typeof fetch = async (
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> => {
  const url =
    typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const headers = normalizeHeaders(init?.headers);

  const message: ApiRequestMessage = {
    type: EXT_MSG_API_REQUEST,
    url,
    method: (init?.method as string | undefined) ?? 'GET',
    ...(headers ? { headers } : {}),
    ...(typeof init?.body === 'string' ? { body: init.body } : {}),
  };

  const resp = (await chrome.runtime.sendMessage(message)) as ApiResponseMessage | undefined;
  if (!resp) {
    throw new TypeError('Failed to fetch: no response from service worker');
  }
  if (resp.status === 0) {
    throw new TypeError(`Failed to fetch: ${resp.error ?? 'network error'}`);
  }

  // 仅实现 lib/api.ts 实际消费的 Response 表面；不构造真实 Response（body 已在 SW 读取）。
  return {
    ok: resp.ok,
    status: resp.status,
    statusText: resp.statusText,
    url,
    headers: new Headers(),
    json: async () => JSON.parse(resp.bodyText) as unknown,
    text: async () => resp.bodyText,
  } as unknown as Response;
};
