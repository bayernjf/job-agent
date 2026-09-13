/**
 * API 客户端单测：用注入的 fetchImpl 覆盖缓存命中 / 轮询 / 失败 / 契约校验。
 */
import { describe, expect, it } from 'vitest';
import { JobAgentApi, matchJobs } from './api.js';

const VALID_PROFILE = {
  schemaVersion: '0.1',
  profileId: 'prof-1',
  generatedAt: '2026-09-12T00:00:00.000Z',
  analyzerVersion: '0.1.0',
  subject: {
    platform: 'github',
    login: 'demo-dev',
    profileUrl: 'https://github.com/demo-dev',
    claimed: false,
  },
  headline: 'engineer',
  skills: [],
  authenticity: { status: 'likely_authentic', confidence: 0.8 },
};

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

/** 按调用顺序消费的 fake fetch */
function seqFetch(handlers: Array<(url: string, init?: RequestInit) => Response>): typeof fetch {
  let i = 0;
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const h = handlers[Math.min(i, handlers.length - 1)]!;
    i += 1;
    return h(String(url), init);
  }) as typeof fetch;
}

describe('JobAgentApi.fetchProfile', () => {
  it('returns profile directly when cache hits (profileId present)', async () => {
    const api = new JobAgentApi({
      baseUrl: 'http://api.test',
      fetchImpl: seqFetch([
        () => jsonResponse(200, { profileId: 'prof-1', status: 'succeeded', cached: true }),
        () => jsonResponse(200, VALID_PROFILE),
      ]),
    });
    const p = await api.fetchProfile('demo-dev');
    expect(p.subject.login).toBe('demo-dev');
  });

  it('polls the job until succeeded then fetches the profile', async () => {
    const api = new JobAgentApi({
      baseUrl: 'http://api.test',
      pollMs: 1,
      timeoutMs: 1000,
      fetchImpl: seqFetch([
        () => jsonResponse(201, { jobId: 'job-1', status: 'queued' }),
        () => jsonResponse(200, { id: 'job-1', status: 'running' }),
        () => jsonResponse(200, { id: 'job-1', status: 'succeeded', profileId: 'prof-1' }),
        () => jsonResponse(200, VALID_PROFILE),
      ]),
    });
    const p = await api.fetchProfile('demo-dev');
    expect(p.authenticity.status).toBe('likely_authentic');
  });

  it('throws when the job fails', async () => {
    const api = new JobAgentApi({
      baseUrl: 'http://api.test',
      pollMs: 1,
      timeoutMs: 500,
      fetchImpl: seqFetch([
        () => jsonResponse(201, { jobId: 'job-1', status: 'queued' }),
        () => jsonResponse(200, { id: 'job-1', status: 'failed', error: 'rate limited' }),
      ]),
    });
    await expect(api.fetchProfile('demo-dev')).rejects.toThrow(/rate limited/);
  });

  it('throws on validation failure (400)', async () => {
    const api = new JobAgentApi({
      baseUrl: 'http://api.test',
      fetchImpl: seqFetch([() => jsonResponse(400, { error: 'validation failed' })]),
    });
    await expect(api.fetchProfile('!!bad!!')).rejects.toThrow(/HTTP 400/);
  });

  it('throws when the profile payload violates the exportable schema', async () => {
    const api = new JobAgentApi({
      baseUrl: 'http://api.test',
      fetchImpl: seqFetch([
        () => jsonResponse(200, { profileId: 'prof-1', status: 'succeeded' }),
        () => jsonResponse(200, { ...VALID_PROFILE, subject: { platform: 'github' } }), // 缺 login/profileUrl
      ]),
    });
    await expect(api.fetchProfile('demo-dev')).rejects.toThrow(/exportable schema/);
  });
});


describe('matchJobs', () => {
  it('returns matched jobs from POST /job-postings/match with profileId', async () => {
    let capturedBody: unknown;
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      capturedBody = init?.body ? JSON.parse(String(init.body)) : undefined;
      return jsonResponse(200, {
        matches: [
          { score: 7, matchedSkills: ['TypeScript', 'React'], posting: { title: 'Senior FE', company: 'Acme', sourceUrl: 'https://example.test/1' } },
        ],
      });
    }) as typeof fetch;
    const out = await matchJobs('http://api.test', 'prof-1', { limit: 3, fetchImpl });
    expect(out).toHaveLength(1);
    expect(out[0]!.score).toBe(7);
    expect(out[0]!.matchedSkills).toEqual(['TypeScript', 'React']);
    expect(capturedBody).toEqual({ profileId: 'prof-1', limit: 3 });
  });

  it('returns empty array when matches field is missing', async () => {
    const fetchImpl = (async () => jsonResponse(200, {})) as typeof fetch;
    const out = await matchJobs('http://api.test', 'prof-1', { fetchImpl });
    expect(out).toEqual([]);
  });

  it('throws on HTTP error', async () => {
    const fetchImpl = (async () => jsonResponse(500, { error: 'boom' })) as typeof fetch;
    await expect(matchJobs('http://api.test', 'prof-1', { fetchImpl })).rejects.toThrow(/HTTP 500/);
  });
});
