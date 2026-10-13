/**
 * Tavily 客户端测试：请求形状（Bearer 认证、POST search 端点、body 参数）、
 * 响应解析、HTTP 非 2xx 抛错。fetch 注入，不打真实网络。
 */
import { describe, expect, it, vi } from 'vitest';
import { TavilySearchClient } from './tavily-client.js';

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

describe('TavilySearchClient', () => {
  it('POSTs to the search endpoint with Bearer auth and expected body', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        results: [
          {
            title: 'Backend Engineer at Acme',
            url: 'https://acme.com/jobs/1',
            content: 'We are hiring in Berlin.',
            score: 0.95,
          },
        ],
      }),
    );
    const client = new TavilySearchClient({ apiKey: 'tvly-test', fetchImpl });
    const results = await client.search('Berlin backend engineer', { maxResults: 5 });

    expect(results).toHaveLength(1);
    expect(results[0]!.title).toBe('Backend Engineer at Acme');
    const [url, init] = fetchImpl.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe('https://api.tavily.com/search');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tvly-test');
    const body = JSON.parse(String(init.body));
    expect(body.query).toBe('Berlin backend engineer');
    expect(body.max_results).toBe(5);
    expect(body.search_depth).toBe('basic');
  });

  it('passes include_domains only when provided (ATS hybrid recall)', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ results: [] }));
    const client = new TavilySearchClient({ apiKey: 'tvly-test', fetchImpl });

    await client.search('q', { includeDomains: ['jobs.lever.co'] });
    let body = JSON.parse(String((fetchImpl.mock.calls[0]! as unknown as [string, RequestInit])[1].body));
    expect(body.include_domains).toEqual(['jobs.lever.co']);

    await client.search('q', {});
    body = JSON.parse(String((fetchImpl.mock.calls[1]! as unknown as [string, RequestInit])[1].body));
    expect(body.include_domains).toBeUndefined();
  });

  it('throws on non-2xx responses', async () => {
    const client = new TavilySearchClient({
      apiKey: 'tvly-test',
      fetchImpl: async () => jsonResponse({ error: 'rate limited' }, 429),
    });
    await expect(client.search('q', {})).rejects.toThrow(/429/);
  });

  it('fires onQuery exactly once on the success path (计量回调，决策 #25 ④ Wave C)', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ results: [] }));
    const client = new TavilySearchClient({ apiKey: 'tvly-test', fetchImpl });
    const onQuery = vi.fn();

    await client.search('q', { onQuery });

    expect(onQuery).toHaveBeenCalledTimes(1);
  });

  it('never fires onQuery on failure paths (非 2xx / 网络错误)', async () => {
    const onQuery = vi.fn();
    const nonOk = new TavilySearchClient({
      apiKey: 'tvly-test',
      fetchImpl: async () => jsonResponse({ error: 'rate limited' }, 429),
    });
    await expect(nonOk.search('q', { onQuery })).rejects.toThrow(/429/);

    const networkDown = new TavilySearchClient({
      apiKey: 'tvly-test',
      fetchImpl: async () => {
        throw new Error('socket hang up');
      },
    });
    await expect(networkDown.search('q', { onQuery })).rejects.toThrow(/socket hang up/);

    expect(onQuery).not.toHaveBeenCalled();
  });
});
