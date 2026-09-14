import { describe, expect, it, vi } from 'vitest';
import { GiteeClient, GiteeSourceError } from './client.js';

const silentLog = { info() {}, warn() {}, error() {} };

function makeClient(fetchImpl: typeof fetch, budgetLimit = 100): GiteeClient {
  return new GiteeClient({ fetchImpl, sleep: async () => {}, budgetLimit, log: silentLog });
}

function json(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: init.headers,
  });
}

describe('GiteeClient.listAll pagination', () => {
  it('follows pages until a short page and honors x-total', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('page=1')) return json([{ id: 1 }, { id: 2 }], { headers: { 'x-total': '3' } });
      return json([{ id: 3 }]);
    }) as unknown as typeof fetch;

    const client = makeClient(fetchImpl);
    const rows = await client.listAll<{ id: number }>('/users/alice/repos', { perPage: 2, maxPages: 5 });
    expect(rows.map((r) => r.id)).toEqual([1, 2, 3]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('stops at maxPages safety cap', async () => {
    const fetchImpl = vi.fn(async () => json([{ id: 1 }, { id: 2 }])) as unknown as typeof fetch;
    const client = makeClient(fetchImpl);
    const rows = await client.listAll('/x', { perPage: 2, maxPages: 2 });
    expect(rows).toHaveLength(4);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe('GiteeClient conditional requests / retries', () => {
  it('reuses cached body on 304 Not Modified', async () => {
    const body = { login: 'alice' };
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.headers && (init.headers as Record<string, string>)['If-None-Match']) {
        return new Response(null, { status: 304 });
      }
      return json(body, { headers: { etag: 'W/"v1"' } });
    }) as unknown as typeof fetch;

    const client = makeClient(fetchImpl);
    const first = await client.get<{ login: string }>('/users/alice');
    const second = await client.get<{ login: string }>('/users/alice');
    expect(first).toEqual(body);
    expect(second).toEqual(body);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('retries on 429 then succeeds', async () => {
    const fetchImpl = vi.fn(async () => {
      const calls = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.length;
      return calls === 1 ? new Response(null, { status: 429 }) : json({ ok: true });
    }) as unknown as typeof fetch;

    const client = makeClient(fetchImpl);
    const data = await client.get<{ ok: boolean }>('/x');
    expect(data.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('retries on 503 then succeeds', async () => {
    const fetchImpl = vi.fn(async () => {
      const calls = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.length;
      return calls === 1 ? new Response(null, { status: 503 }) : json({ ok: true });
    }) as unknown as typeof fetch;

    const client = makeClient(fetchImpl);
    const data = await client.get<{ ok: boolean }>('/x');
    expect(data.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('gives up after retries on persistent 5xx', async () => {
    const fetchImpl = (async () => new Response(null, { status: 500 })) as typeof fetch;
    const client = makeClient(fetchImpl);
    await expect(client.get('/x')).rejects.toMatchObject({ code: 'api_error' });
  });

  it('maps 404 to not_found', async () => {
    const fetchImpl = (async () => new Response(null, { status: 404 })) as typeof fetch;
    const client = makeClient(fetchImpl);
    await expect(client.get('/users/nobody')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('throws budget_exhausted once the per-profile call cap is reached', async () => {
    const fetchImpl = (async () => json([{ id: 1 }])) as typeof fetch;
    const client = makeClient(fetchImpl, 1);
    await client.listAll('/x', { perPage: 1, maxPages: 3 }).catch(() => undefined); // 用掉唯一一次
    await expect(client.get('/y')).rejects.toBeInstanceOf(GiteeSourceError);
  });
});
