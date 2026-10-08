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

  it('throws on non-2xx responses', async () => {
    const client = new TavilySearchClient({
      apiKey: 'tvly-test',
      fetchImpl: async () => jsonResponse({ error: 'rate limited' }, 429),
    });
    await expect(client.search('q', {})).rejects.toThrow(/429/);
  });
});
