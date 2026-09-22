import { afterEach, describe, expect, it, vi } from 'vitest';
import { swFetch } from './sw-fetch';
import { EXT_MSG_API_REQUEST } from './sw-relay';

/** 安装 chrome.runtime.sendMessage 的假实现。 */
function stubChrome(sendMessage: ReturnType<typeof vi.fn>): void {
  vi.stubGlobal('chrome', {
    runtime: { sendMessage },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('swFetch (content script 侧 fetch 适配器)', () => {
  it('把 url/method/headers/body 组装成代发消息并解析返回', async () => {
    const sendMessage = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      bodyText: '{"a":1}',
    }));
    stubChrome(sendMessage);

    const res = await swFetch('http://localhost:3000/analyze', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"username":"torvalds"}',
    });

    expect(sendMessage).toHaveBeenCalledWith({
      type: EXT_MSG_API_REQUEST,
      url: 'http://localhost:3000/analyze',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"username":"torvalds"}',
    });
    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ a: 1 });
    await expect(res.text()).resolves.toBe('{"a":1}');
  });

  it('GET 缺省 method，无 headers/body 时不带这些字段', async () => {
    const sendMessage = vi.fn(async () => ({ ok: true, status: 200, statusText: '', bodyText: '' }));
    stubChrome(sendMessage);

    await swFetch('http://localhost:3000/health');

    expect(sendMessage).toHaveBeenCalledWith({
      type: EXT_MSG_API_REQUEST,
      url: 'http://localhost:3000/health',
      method: 'GET',
    });
  });

  it('接受 URL 对象输入', async () => {
    const sendMessage = vi.fn(async () => ({ ok: true, status: 200, statusText: '', bodyText: '' }));
    stubChrome(sendMessage);

    await swFetch(new URL('http://localhost:3000/jobs/1'));

    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'http://localhost:3000/jobs/1' }),
    );
  });

  it('SW 返回 status=0 网络错误时抛 TypeError（与原生 fetch 失败一致）', async () => {
    stubChrome(vi.fn(async () => ({ ok: false, status: 0, statusText: '', bodyText: '', error: 'network error' })));
    await expect(swFetch('http://localhost:3000/health')).rejects.toBeInstanceOf(TypeError);
  });

  it('SW 无响应（undefined）时抛 TypeError', async () => {
    stubChrome(vi.fn(async () => undefined));
    await expect(swFetch('http://localhost:3000/health')).rejects.toBeInstanceOf(TypeError);
  });

  it('非 2xx 不抛错（交由调用方按 ok/status 处理）', async () => {
    stubChrome(vi.fn(async () => ({ ok: false, status: 404, statusText: 'Not Found', bodyText: '{}' })));
    const res = await swFetch('http://localhost:3000/profiles/x/exportable');
    expect(res.ok).toBe(false);
    expect(res.status).toBe(404);
  });
});
