import { afterEach, describe, expect, it, vi } from 'vitest';
import { createJobHttpClient, JobHttpError } from './http-client.js';

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
  } as unknown as Response;
}

const noSleep = () => Promise.resolve();

afterEach(() => vi.restoreAllMocks());

describe('createJobHttpClient', () => {
  it('returns parsed JSON on 200', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { ok: true }));
    const http = createJobHttpClient({ fetchImpl, sleep: noSleep });
    await expect(http.getJson('https://x.test/a')).resolves.toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('does not retry on 4xx (except 429)', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(404, { error: 'no' }));
    const http = createJobHttpClient({ fetchImpl, sleep: noSleep, retries: 2 });
    await expect(http.getJson('https://x.test/missing')).rejects.toBeInstanceOf(JobHttpError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('retries on 5xx then succeeds', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(503, {}))
      .mockResolvedValueOnce(jsonResponse(200, { v: 1 }));
    const http = createJobHttpClient({ fetchImpl, sleep: noSleep, retries: 2 });
    await expect(http.getJson('https://x.test/r')).resolves.toEqual({ v: 1 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('retries on network error then succeeds', async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(jsonResponse(200, { v: 2 }));
    const http = createJobHttpClient({ fetchImpl, sleep: noSleep, retries: 2 });
    await expect(http.getJson('https://x.test/n')).resolves.toEqual({ v: 2 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('honors Retry-After on 429', async () => {
    const sleep = vi.fn(noSleep);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(429, {}, { 'retry-after': '3' }))
      .mockResolvedValueOnce(jsonResponse(200, { v: 3 }));
    const http = createJobHttpClient({ fetchImpl, sleep, retries: 2 });
    await http.getJson('https://x.test/limit');
    expect(sleep).toHaveBeenCalledWith(3000);
  });
});
