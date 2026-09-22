import { describe, expect, it, vi } from 'vitest';
import {
  EXT_MSG_API_REQUEST,
  isApiRequestMessage,
  relayApiRequest,
  type ApiRequestMessage,
} from './sw-relay';

/** 构造一个最小 Response-like 的 fetch 假实现。 */
function fakeFetch(response: Partial<Response> | Promise<Partial<Response>>): typeof fetch {
  return (async () => (await response) as Response) as unknown as typeof fetch;
}

function req(over: Partial<ApiRequestMessage> = {}): ApiRequestMessage {
  return { type: EXT_MSG_API_REQUEST, url: 'http://localhost:3000/health', ...over };
}

describe('relayApiRequest (service worker 侧代发纯函数)', () => {
  it('透传 GET 并回传状态与正文', async () => {
    const fetchImpl = vi.fn(fakeFetch({ ok: true, status: 200, statusText: 'OK', text: async () => '{"status":"ok"}' }));
    const out = await relayApiRequest(req(), fetchImpl);
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://localhost:3000/health',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(out).toMatchObject({ ok: true, status: 200, statusText: 'OK', bodyText: '{"status":"ok"}' });
    expect(out.error).toBeUndefined();
  });

  it('透传 POST 的 method、headers 与 body', async () => {
    const fetchImpl = vi.fn(fakeFetch({ ok: true, status: 200, text: async () => '{}' }));
    await relayApiRequest(
      req({
        url: 'http://localhost:3000/analyze',
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"username":"torvalds"}',
      }),
      fetchImpl,
    );
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://localhost:3000/analyze',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"username":"torvalds"}' },
    );
  });

  it('非 2xx 仍回传状态码与正文（不抛错，交给调用方按 res.ok 判断）', async () => {
    const out = await relayApiRequest(
      req({ url: 'http://localhost:3000/profiles/x/exportable' }),
      fakeFetch({ ok: false, status: 404, statusText: 'Not Found', text: async () => '{"error":"not_found"}' }),
    );
    expect(out).toMatchObject({ ok: false, status: 404, bodyText: '{"error":"not_found"}' });
  });

  it('底层 fetch 网络失败时收敛为 status=0 + error，不抛出', async () => {
    const out = await relayApiRequest(
      req(),
      (() => Promise.reject(new TypeError('NetworkError'))) as unknown as typeof fetch,
    );
    expect(out.status).toBe(0);
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/NetworkError/);
  });

  it('拒绝 http(s) 以外的协议', async () => {
    const out = await relayApiRequest(req({ url: 'ftp://localhost:3000/x' }));
    expect(out).toMatchObject({ status: 0, error: 'unsupported scheme' });
  });

  it('拒绝无法解析的 URL', async () => {
    const out = await relayApiRequest(req({ url: 'not-a-url' }));
    expect(out).toMatchObject({ status: 0, error: 'invalid URL' });
  });

  it('只放行 GET/POST（DELETE 被拒）', async () => {
    const out = await relayApiRequest(req({ method: 'DELETE' }));
    expect(out).toMatchObject({ status: 0, error: 'unsupported method' });
  });

  it('method 缺省为 GET 且大小写归一', async () => {
    const fetchImpl = vi.fn(fakeFetch({ ok: true, status: 200, text: async () => '' }));
    await relayApiRequest(req({ method: 'get' }), fetchImpl);
    expect(fetchImpl).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ method: 'GET' }),
    );
  });
});

describe('isApiRequestMessage', () => {
  it('识别合法消息、拒绝其他', () => {
    expect(isApiRequestMessage({ type: EXT_MSG_API_REQUEST, url: 'x' })).toBe(true);
    expect(isApiRequestMessage({ type: 'other' })).toBe(false);
    expect(isApiRequestMessage(null)).toBe(false);
    expect(isApiRequestMessage('string')).toBe(false);
  });
});
