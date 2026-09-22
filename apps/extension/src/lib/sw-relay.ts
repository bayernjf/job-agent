/**
 * Service-worker API relay：content script 与 background 共用的代发协议与纯函数。
 *
 * 为什么需要：content script 的 fetch 以「页面源」发起。真实 ATS 页是公网 HTTPS
 * （如 https://job-boards.greenhouse.io），而 API 在开发期是 http://localhost:3000、
 * 生产期是另一个 HTTPS 源——页面源请求会同时撞上 CORS、混合内容（Mixed Content）
 * 与私有网络访问（Private Network Access）限制，表现为面板 “Failed to fetch”。
 *
 * MV3 service worker 以扩展源（chrome-extension://<id>）发起请求；只要目标 API 主机
 * 声明在 manifest 的 host_permissions 中，这类请求即被跨域授权，豁免上述页面级限制。
 * 因此 content script 不直接 fetch，而是发内部消息给 SW，由 SW 代发并回传可序列化结果。
 *
 * 本文件不含任何 chrome.* 调用，纯函数 relayApiRequest 可在单测中注入 fetch 覆盖。
 */

export const EXT_MSG_API_REQUEST = 'jobagent.apiRequest';

/** content → background 的内部代发请求（结构化克隆可序列化）。 */
export interface ApiRequestMessage {
  type: typeof EXT_MSG_API_REQUEST;
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

/** background → content 的代发结果（status=0 且带 error 表示请求未能发出/网络失败）。 */
export interface ApiResponseMessage {
  ok: boolean;
  status: number;
  statusText: string;
  bodyText: string;
  error?: string;
}

/** 与后端 CORS allowMethods 对齐，代发只放行只读/触发分析两类方法。 */
const ALLOWED_METHODS = new Set(['GET', 'POST']);

function failure(error: string): ApiResponseMessage {
  return { ok: false, status: 0, statusText: '', bodyText: '', error };
}

/** 类型守卫：识别内部代发消息。 */
export function isApiRequestMessage(value: unknown): value is ApiRequestMessage {
  return (
    !!value &&
    typeof value === 'object' &&
    (value as { type?: unknown }).type === EXT_MSG_API_REQUEST
  );
}

/**
 * 在 service worker 侧执行一次代发请求，返回结构化克隆安全的结果。
 * 任何异常都收敛为 status=0 + error，绝不抛出（消息通道必须 resolve）。
 */
export async function relayApiRequest(
  message: ApiRequestMessage,
  fetchImpl: typeof fetch = fetch,
): Promise<ApiResponseMessage> {
  let parsed: URL;
  try {
    parsed = new URL(message.url);
  } catch {
    return failure('invalid URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return failure('unsupported scheme');
  }
  const method = (message.method ?? 'GET').toUpperCase();
  if (!ALLOWED_METHODS.has(method)) {
    return failure('unsupported method');
  }
  try {
    const res = await fetchImpl(message.url, {
      method,
      ...(message.headers ? { headers: message.headers } : {}),
      ...(message.body !== undefined ? { body: message.body } : {}),
    });
    const bodyText = await res.text();
    return { ok: res.ok, status: res.status, statusText: res.statusText, bodyText };
  } catch (err) {
    return failure((err as Error)?.message || 'network error');
  }
}
