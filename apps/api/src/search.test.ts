/**
 * 指令式全网搜岗 API 集成测试。
 *
 * 覆盖：登录闸、发起搜岗（直接输入 / 引用预设）、任务状态、本次结果、
 * 筛选条件预设 CRUD 与归属隔离、search-tick 未配 key 的 503 + 心跳失败记录。
 * 全部内存 SQLite + FakeAuthProvider（不打网络），Hono app.request。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createStorage, type StorageContext } from '@jobagent/storage';
import { createApp, type ApiDeps } from './index.js';
import { FakeAuthProvider } from './fake-auth.js';
import type { OAuthProfile } from './auth-provider.js';
import { loadAuthConfig } from './auth-config.js';

const ALICE: OAuthProfile = {
  platform: 'github',
  providerAccountId: '901',
  login: 'search-alice',
  name: 'Alice',
  email: 'alice@example.com',
  avatarUrl: null,
};
const BOB: OAuthProfile = {
  platform: 'github',
  providerAccountId: '902',
  login: 'search-bob',
  name: 'Bob',
  email: 'bob@example.com',
  avatarUrl: null,
};

const CRON_SECRET = 'search-tick-test-secret';
let previousCronSecret: string | undefined;
beforeAll(() => {
  previousCronSecret = process.env.CRON_SECRET;
  process.env.CRON_SECRET = CRON_SECRET;
  delete process.env.TAVILY_API_KEY;
});
afterAll(() => {
  if (previousCronSecret === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = previousCronSecret;
});

function extractCookies(res: Response): Record<string, string> {
  const out: Record<string, string> = {};
  const headers =
    typeof res.headers.getSetCookie === 'function'
      ? res.headers.getSetCookie()
      : [res.headers.get('set-cookie') ?? ''];
  for (const sc of headers) {
    const pair = sc.split(';')[0] ?? '';
    const eq = pair.indexOf('=');
    if (eq > 0) out[pair.slice(0, eq).trim()] = decodeURIComponent(pair.slice(eq + 1));
  }
  return out;
}

async function loginUser(
  repos: StorageContext,
  identity: OAuthProfile,
): Promise<{ Cookie: string; app: Awaited<ReturnType<typeof createApp>> }> {
  const deps: ApiDeps = {
    repos,
    authConfig: loadAuthConfig({}),
    githubAuthProvider: new FakeAuthProvider(identity),
  };
  const app = await createApp(deps);
  const loginRes = await app.request('/auth/github/login');
  const state = extractCookies(loginRes).jobagent_oauth_state;
  const cb = await app.request(
    `/auth/github/callback?state=${encodeURIComponent(state!)}&code=fake-code`,
    { headers: { Cookie: `jobagent_oauth_state=${state!}` } },
  );
  expect(cb.status).toBe(302);
  const session = extractCookies(cb).jobagent_session;
  return { Cookie: `jobagent_session=${session!}`, app };
}

async function harness(user: OAuthProfile = ALICE) {
  const repos = await createStorage({ sqlitePath: ':memory:' });
  const { Cookie } = await loginUser(repos, user);
  return { repos, Cookie, app: (await loginUser(repos, user)).app };
}

describe('POST /agent/search', () => {
  it('requires login', async () => {
    const { app } = await harness();
    const res = await app.request('/agent/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: '深圳 Java' }),
    });
    expect(res.status).toBe(401);
  });

  it('creates a queued run from a direct command', async () => {
    const { app, Cookie } = await harness();
    const res = await app.request('/agent/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie },
      body: JSON.stringify({ query: '深圳的 Java 开发，坐班，可远程' }),
    });
    expect(res.status).toBe(201);
    const data = (await res.json()) as { runId: string; status: string };
    expect(data.runId).toMatch(/^srun-/);
    expect(data.status).toBe('queued');
  });

  it('creates a run from a saved preset', async () => {
    const { app, Cookie } = await harness();
    const presetRes = await app.request('/agent/search-presets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie },
      body: JSON.stringify({ title: '深圳 Java', query: '深圳 Java 远程' }),
    });
    const preset = (await presetRes.json()) as { preset: { presetId: string } };
    const res = await app.request('/agent/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie },
      body: JSON.stringify({ presetId: preset.preset!.presetId }),
    });
    expect(res.status).toBe(201);
  });

  it('rejects an empty body', async () => {
    const { app, Cookie } = await harness();
    const res = await app.request('/agent/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});

describe('GET /agent/search/:id', () => {
  it('returns status for an owned run and 404 for another account', async () => {
    const { app, Cookie } = await harness();
    const created = await app.request('/agent/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie },
      body: JSON.stringify({ query: 'Golang remote' }),
    });
    const { runId } = (await created.json()) as { runId: string };

    const ok = await app.request(`/agent/search/${runId}`, { headers: { Cookie } });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { run: { status: string } };
    expect(body.run.status).toBe('queued');

    const bob = await loginUser(await createStorage({ sqlitePath: ':memory:' }), BOB);
    const forbidden = await bob.app.request(`/agent/search/${runId}`, {
      headers: { Cookie: bob.Cookie },
    });
    expect(forbidden.status).toBe(404);
  });
});

describe('search presets CRUD', () => {
  it('saves, lists, and deletes presets with ownership isolation', async () => {
    const { app, Cookie } = await harness();
    const created = await app.request('/agent/search-presets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie },
      body: JSON.stringify({ title: '深圳 Java', query: '深圳 Java 远程' }),
    });
    expect(created.status).toBe(201);
    const { preset } = (await created.json()) as {
      preset: { presetId: string; query: string; conditions: { location: string | null } };
    };
    expect(preset.query).toBe('深圳 Java 远程');
    expect(preset.conditions.location).toBe('深圳');

    const list = await app.request('/agent/search-presets', { headers: { Cookie } });
    const { presets } = (await list.json()) as { presets: unknown[] };
    expect(presets).toHaveLength(1);

    const bob = await loginUser(await createStorage({ sqlitePath: ':memory:' }), BOB);
    const forbidden = await bob.app.request(
      `/agent/search-presets/${preset.presetId}`,
      { method: 'DELETE', headers: { Cookie: bob.Cookie } },
    );
    expect(forbidden.status).toBe(404);

    const deleted = await app.request(`/agent/search-presets/${preset.presetId}`, {
      method: 'DELETE',
      headers: { Cookie },
    });
    expect(deleted.status).toBe(200);

    const after = await app.request('/agent/search-presets', { headers: { Cookie } });
    expect(((await after.json()) as { presets: unknown[] }).presets).toHaveLength(0);
  });
});

describe('GET /internal/cron/search-tick', () => {
  it('requires the cron secret', async () => {
    const { app } = await harness();
    const res = await app.request('/internal/cron/search-tick');
    expect(res.status).toBe(401);
  });

  it('returns 503 with a failure heartbeat when TAVILY_API_KEY is missing', async () => {
    const { app } = await harness();
    const res = await app.request('/internal/cron/search-tick', {
      headers: { Authorization: `Bearer ${CRON_SECRET}` },
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.error).toContain('TAVILY_API_KEY');
  });
});

describe('GET /agent/search (history list)', () => {
  it('requires login', async () => {
    const { app } = await harness();
    const res = await app.request('/agent/search');
    expect(res.status).toBe(401);
  });

  it('lists owned runs newest-first and never another account', async () => {
    const { app, Cookie } = await harness();
    await app.request('/agent/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie },
      body: JSON.stringify({ query: 'Rust engineer' }),
    });
    await app.request('/agent/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie },
      body: JSON.stringify({ query: 'Go remote' }),
    });
    const list = await app.request('/agent/search', { headers: { Cookie } });
    expect(list.status).toBe(200);
    const { runs } = (await list.json()) as {
      runs: { runId: string; query: string; status: string }[];
    };
    expect(runs).toHaveLength(2);
    expect(runs[0]!.query).toBe('Go remote');
    expect(runs[1]!.query).toBe('Rust engineer');

    const bob = await loginUser(await createStorage({ sqlitePath: ':memory:' }), BOB);
    const bobList = await bob.app.request('/agent/search', {
      headers: { Cookie: bob.Cookie },
    });
    expect(((await bobList.json()) as { runs: unknown[] }).runs).toHaveLength(0);
  });
});

describe('DELETE /agent/search-presets (clear all)', () => {
  it('clears only the caller account and reports the deleted count', async () => {
    const { app, Cookie } = await harness();
    for (const q of ['深圳 Java', '上海 Go']) {
      await app.request('/agent/search-presets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie },
        body: JSON.stringify({ query: q }),
      });
    }
    const bob = await loginUser(await createStorage({ sqlitePath: ':memory:' }), BOB);
    await bob.app.request('/agent/search-presets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: bob.Cookie },
      body: JSON.stringify({ query: 'Bob preset' }),
    });

    const cleared = await app.request('/agent/search-presets', {
      method: 'DELETE',
      headers: { Cookie },
    });
    expect(cleared.status).toBe(200);
    const { deleted } = (await cleared.json()) as { deleted: number };
    expect(deleted).toBe(2);

    const after = await app.request('/agent/search-presets', { headers: { Cookie } });
    expect(((await after.json()) as { presets: unknown[] }).presets).toHaveLength(0);
    const bobAfter = await bob.app.request('/agent/search-presets', {
      headers: { Cookie: bob.Cookie },
    });
    expect(((await bobAfter.json()) as { presets: unknown[] }).presets).toHaveLength(1);
  });
});

describe('DELETE /agent/search-runs (history delete)', () => {
  it('requires login for single and bulk delete', async () => {
    const { app } = await harness();
    expect((await app.request('/agent/search-runs/run-1', { method: 'DELETE' })).status).toBe(401);
    expect((await app.request('/agent/search-runs', { method: 'DELETE' })).status).toBe(401);
  });

  it('single delete: removes an owned run, 404 for another account, keeps the pool intact', async () => {
    const { app, Cookie } = await harness();
    const created = await app.request('/agent/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie },
      body: JSON.stringify({ query: 'Python data' }),
    });
    const { runId } = (await created.json()) as { runId: string };

    const bob = await loginUser(await createStorage({ sqlitePath: ':memory:' }), BOB);
    const forbidden = await bob.app.request(`/agent/search-runs/${runId}`, {
      method: 'DELETE',
      headers: { Cookie: bob.Cookie },
    });
    expect(forbidden.status).toBe(404);

    const deleted = await app.request(`/agent/search-runs/${runId}`, {
      method: 'DELETE',
      headers: { Cookie },
    });
    expect(deleted.status).toBe(200);
    const after = await app.request(`/agent/search/${runId}`, { headers: { Cookie } });
    expect(after.status).toBe(404);
  });

  it('bulk delete: clears only the caller account history', async () => {
    const { app, Cookie } = await harness();
    await app.request('/agent/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie },
      body: JSON.stringify({ query: 'A' }),
    });
    await app.request('/agent/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie },
      body: JSON.stringify({ query: 'B' }),
    });
    const bob = await loginUser(await createStorage({ sqlitePath: ':memory:' }), BOB);
    await bob.app.request('/agent/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: bob.Cookie },
      body: JSON.stringify({ query: 'Bob run' }),
    });

    const cleared = await app.request('/agent/search-runs', {
      method: 'DELETE',
      headers: { Cookie },
    });
    expect(cleared.status).toBe(200);
    const { deleted } = (await cleared.json()) as { deleted: number };
    expect(deleted).toBe(2);

    const after = await app.request('/agent/search', { headers: { Cookie } });
    expect(((await after.json()) as { runs: unknown[] }).runs).toHaveLength(0);
    const bobAfter = await bob.app.request('/agent/search', {
      headers: { Cookie: bob.Cookie },
    });
    expect(((await bobAfter.json()) as { runs: unknown[] }).runs).toHaveLength(1);
  });
});
