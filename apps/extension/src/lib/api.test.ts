/**
 * API 客户端单测：用注入的 fetchImpl 覆盖 by-subject 解析 / 回退分析 / 轮询 / 失败 / 契约校验。
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
  const subjectUrl = (u: string) => u.includes('/profiles/by-subject/');
  const exportableUrl = (u: string) => u.includes('/exportable');
  const analyzeUrl = (u: string) => u.endsWith('/analyze');
  const subjectFound = () =>
    jsonResponse(200, { profileId: 'prof-1', status: 'complete', cached: true });
  const subjectMissing = () =>
    jsonResponse(404, { error: 'no complete profile for subject', code: 'PROFILE_NOT_FOUND' });

  it('loads an existing snapshot via by-subject without calling POST /analyze', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string | URL | Request) => {
      const u = String(url);
      calls.push(u);
      if (analyzeUrl(u)) throw new Error('POST /analyze must not be called for an existing snapshot');
      if (subjectUrl(u)) return subjectFound();
      if (exportableUrl(u)) return jsonResponse(200, VALID_PROFILE);
      return jsonResponse(404, {});
    }) as typeof fetch;
    const api = new JobAgentApi({ baseUrl: 'http://api.test', fetchImpl });
    const p = await api.fetchProfile('demo-dev');
    expect(p.subject.login).toBe('demo-dev');
    expect(calls.some(subjectUrl)).toBe(true);
    expect(calls.some(analyzeUrl)).toBe(false);
  });

  it('falls back to POST /analyze when by-subject returns 404 (cached profileId)', async () => {
    const api = new JobAgentApi({
      baseUrl: 'http://api.test',
      fetchImpl: seqFetch([
        subjectMissing,
        () => jsonResponse(200, { profileId: 'prof-1', status: 'succeeded', cached: true }),
        () => jsonResponse(200, VALID_PROFILE),
      ]),
    });
    const p = await api.fetchProfile('demo-dev');
    expect(p.subject.login).toBe('demo-dev');
  });

  it('forwards platform=all straight to analyze (no by-subject lookup)', async () => {
    let receivedBody: unknown;
    let sawSubjectLookup = false;
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (subjectUrl(u)) {
        sawSubjectLookup = true;
        return subjectMissing();
      }
      if (analyzeUrl(u)) {
        receivedBody = init?.body;
        return jsonResponse(200, { profileId: 'prof-1', status: 'succeeded', cached: true });
      }
      if (exportableUrl(u)) return jsonResponse(200, VALID_PROFILE);
      return jsonResponse(404, {});
    }) as typeof fetch;
    const api = new JobAgentApi({ baseUrl: 'http://api.test', fetchImpl });
    await api.fetchProfile('demo-dev', 'all');
    expect(JSON.parse(String(receivedBody))).toMatchObject({ username: 'demo-dev', platform: 'all' });
    expect(sawSubjectLookup).toBe(false);
  });

  it('polls the job until succeeded then fetches the profile (after by-subject 404)', async () => {
    const api = new JobAgentApi({
      baseUrl: 'http://api.test',
      pollMs: 1,
      timeoutMs: 1000,
      fetchImpl: seqFetch([
        subjectMissing,
        () => jsonResponse(201, { jobId: 'job-1', status: 'queued' }),
        () => jsonResponse(200, { id: 'job-1', status: 'running' }),
        () => jsonResponse(200, { id: 'job-1', status: 'succeeded', profileId: 'prof-1' }),
        () => jsonResponse(200, VALID_PROFILE),
      ]),
    });
    const p = await api.fetchProfile('demo-dev');
    expect(p.authenticity.status).toBe('likely_authentic');
  });

  it('throws when the job fails (after by-subject 404)', async () => {
    const api = new JobAgentApi({
      baseUrl: 'http://api.test',
      pollMs: 1,
      timeoutMs: 500,
      fetchImpl: seqFetch([
        subjectMissing,
        () => jsonResponse(201, { jobId: 'job-1', status: 'queued' }),
        () => jsonResponse(200, { id: 'job-1', status: 'failed', error: 'rate limited' }),
      ]),
    });
    await expect(api.fetchProfile('demo-dev')).rejects.toThrow(/rate limited/);
  });

  it('throws on a non-404 by-subject error without falling back to analyze', async () => {
    let posted = false;
    const fetchImpl = (async (url: string | URL | Request) => {
      const u = String(url);
      if (subjectUrl(u)) return jsonResponse(500, { error: 'boom' });
      if (analyzeUrl(u)) {
        posted = true;
        return jsonResponse(200, {});
      }
      return jsonResponse(404, {});
    }) as typeof fetch;
    const api = new JobAgentApi({ baseUrl: 'http://api.test', fetchImpl });
    await expect(api.fetchProfile('demo-dev')).rejects.toThrow(/profile lookup failed \(HTTP 500\)/);
    expect(posted).toBe(false);
  });

  it('throws on validation failure (400 from the lookup)', async () => {
    const api = new JobAgentApi({
      baseUrl: 'http://api.test',
      fetchImpl: seqFetch([() => jsonResponse(400, { error: 'validation failed' })]),
    });
    await expect(api.fetchProfile('!!bad!!')).rejects.toThrow(/HTTP 400/);
  });

  it('throws when the exportable payload violates the schema (snapshot resolved by-subject)', async () => {
    const api = new JobAgentApi({
      baseUrl: 'http://api.test',
      fetchImpl: seqFetch([
        subjectFound,
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
    expect(out.matches).toHaveLength(1);
    expect(out.matches[0]!.score).toBe(7);
    expect(out.matches[0]!.matchedSkills).toEqual(['TypeScript', 'React']);
    expect(capturedBody).toEqual({ profileId: 'prof-1', limit: 3 });
  });

  it('returns empty matches when matches field is missing', async () => {
    const fetchImpl = (async () => jsonResponse(200, {})) as typeof fetch;
    const out = await matchJobs('http://api.test', 'prof-1', { fetchImpl });
    expect(out.matches).toEqual([]);
  });

  it('passes through explainability fields (decision #10)', async () => {
    const fetchImpl = (async () =>
      jsonResponse(200, {
        matches: [
          {
            score: 6,
            matchedSkills: ['TypeScript'],
            fieldScores: { title: 3, tags: 2, description: 1 },
            skillHits: [{ skill: 'TypeScript', score: 6, fields: ['title', 'tags', 'description'] }],
            skillReasons: [
              {
                skill: 'TypeScript',
                score: 6,
                fields: ['title', 'tags', 'description'],
                kind: 'language',
                depth: 'proficient',
                confidence: 0.9,
                evidenceRefs: ['ev-1'],
              },
            ],
            posting: { title: 'TS Engineer', company: 'Acme', sourceUrl: 'https://example.test/9' },
          },
        ],
      })) as typeof fetch;
    const out = await matchJobs('http://api.test', 'prof-1', { fetchImpl });
    expect(out.matches[0]!.fieldScores).toEqual({ title: 3, tags: 2, description: 1 });
    expect(out.matches[0]!.skillHits).toEqual([
      { skill: 'TypeScript', score: 6, fields: ['title', 'tags', 'description'] },
    ]);
    expect(out.matches[0]!.skillReasons?.[0]).toMatchObject({
      skill: 'TypeScript',
      depth: 'proficient',
      evidenceRefs: ['ev-1'],
    });
  });

  it('passes through top-level evidence dictionary (decision #10)', async () => {
    const fetchImpl = (async () =>
      jsonResponse(200, {
        matches: [{ score: 3, matchedSkills: ['TS'], posting: { title: 't', company: 'c', sourceUrl: 'u' } }],
        evidence: { 'ev-1': { sourceType: 'commit', url: 'https://example.test/c', claim: 'added ts' } },
      })) as typeof fetch;
    const out = await matchJobs('http://api.test', 'prof-1', { fetchImpl });
    expect(out.evidence).toBeDefined();
    expect(out.evidence!['ev-1']!.url).toBe('https://example.test/c');
  });

  it('omits evidence field when absent (exactOptionalPropertyTypes)', async () => {
    const fetchImpl = (async () =>
      jsonResponse(200, { matches: [{ score: 1, matchedSkills: ['x'], posting: { title: 't', company: 'c', sourceUrl: 'u' } }] })) as typeof fetch;
    const out = await matchJobs('http://api.test', 'prof-1', { fetchImpl });
    expect('evidence' in out).toBe(false);
  });

  it('throws on HTTP error', async () => {
    const fetchImpl = (async () => jsonResponse(500, { error: 'boom' })) as typeof fetch;
    await expect(matchJobs('http://api.test', 'prof-1', { fetchImpl })).rejects.toThrow(/HTTP 500/);
  });
});
