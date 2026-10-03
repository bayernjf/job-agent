/**
 * LLM 模型供给路由集成测试（decision #21，design §4）。
 * 内存 SQLite + FakeAuthProvider 完整登录，全程不打网络：
 * - admin 面：匿名 401 / 普通用户 403 / admin 200；PUT 整体替换并刷新缓存；POST refresh 重读仓储
 * - BYOK 面：GET 404 → PUT 加密保存 → GET 只回掩码 → PUT 改配置不换 key → DELETE 204
 * - LLM_ENC_KEY 未配：PUT 503 ENCRYPTION_NOT_CONFIGURED
 * - POST validate：stub global fetch 走成功/失败两分支（最小 max_tokens=1 请求）
 * - ADMIN_ACCOUNT_LOGINS 白名单：登录自动置 is_admin，/auth/me 回 canManageLlmCatalog
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeLlmClient, LlmCoverLetterProvider, createCatalogCache } from '@jobagent/llm';
import { createStorage, type StorageContext } from '@jobagent/storage';
import { createApp, type ApiDeps } from './index.js';
import { FakeAuthProvider } from './fake-auth.js';
import type { OAuthProfile } from './auth-provider.js';
import { loadAuthConfig } from './auth-config.js';

const ADMIN: OAuthProfile = {
  platform: 'github',
  providerAccountId: '201',
  login: 'admin1',
  name: 'Admin',
  email: 'admin@example.com',
  avatarUrl: 'https://example.com/admin.png',
};
const BOB: OAuthProfile = {
  platform: 'github',
  providerAccountId: '202',
  login: 'bob',
  name: 'Bob',
  email: 'bob@example.com',
  avatarUrl: 'https://example.com/bob.png',
};

const ENC_KEY = 'test-enc-key-20261003';

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

function cookieHeader(cookies: Record<string, string>, ...names: string[]): string {
  return names
    .filter((n) => cookies[n] !== undefined)
    .map((n) => `${n}=${cookies[n]}`)
    .join('; ');
}

async function loginAs(
  profile: OAuthProfile,
  repos: StorageContext,
  app: Awaited<ReturnType<typeof createApp>>,
): Promise<Record<string, string>> {
  const loginRes = await app.request('/auth/github/login');
  const stateCookies = extractCookies(loginRes);
  const state = stateCookies.jobagent_oauth_state!;
  const callbackRes = await app.request(
    `/auth/github/callback?state=${encodeURIComponent(state)}&code=fake-code`,
    { headers: { Cookie: cookieHeader(stateCookies, 'jobagent_oauth_state') } },
  );
  const sessionCookies = extractCookies(callbackRes);
  return { jobagent_session: sessionCookies.jobagent_session! };
}

/** 登录后置为 admin，返回带 session Cookie 的 jar（accounts 仓储无 getByLogin，经 /auth/me 取 id）。 */
async function loginAsAdmin(
  repos: StorageContext,
  app: Awaited<ReturnType<typeof createApp>>,
): Promise<Record<string, string>> {
  const cookies = await loginAs(ADMIN, repos, app);
  const me = await app.request('/auth/me', {
    headers: { Cookie: cookieHeader(cookies, 'jobagent_session') },
  });
  const meBody = (await me.json()) as { accountId: string; canManageLlmCatalog?: boolean };
  await repos.accounts.setAdmin(meBody.accountId, true);
  return cookies;
}

async function setup(opts: { encKey?: string | null } = {}) {
  const repos = await createStorage({ sqlitePath: ':memory:' });
  const deps: ApiDeps = {
    repos,
    authConfig: loadAuthConfig({}),
    githubAuthProvider: new FakeAuthProvider(ADMIN),
    llmCatalogCache: createCatalogCache(),
    llmEncKey: opts.encKey === undefined ? ENC_KEY : opts.encKey,
  };
  const app = await createApp(deps);
  return { repos, app };
}

describe('GET /admin/llm-catalog（admin 面鉴权）', () => {
  it('匿名 → 401 AUTH_REQUIRED', async () => {
    const { app } = await setup();
    const res = await app.request('/admin/llm-catalog');
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: 'AUTH_REQUIRED' });
  });

  it('登录但非 admin → 403 FORBIDDEN', async () => {
    const repos = await createStorage({ sqlitePath: ':memory:' });
    const deps: ApiDeps = {
      repos,
      authConfig: loadAuthConfig({}),
      githubAuthProvider: new FakeAuthProvider(BOB),
      llmCatalogCache: createCatalogCache(),
      llmEncKey: ENC_KEY,
    };
    const app = await createApp(deps);
    const cookies = await loginAs(BOB, repos, app);
    const res = await app.request('/admin/llm-catalog', {
      headers: { Cookie: cookieHeader(cookies, 'jobagent_session') },
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'FORBIDDEN' });
  });

  it('admin → 200，回代码默认目录 + envConfigured', async () => {
    const repos = await createStorage({ sqlitePath: ':memory:' });
    const deps: ApiDeps = {
      repos,
      authConfig: loadAuthConfig({}),
      githubAuthProvider: new FakeAuthProvider(ADMIN),
      llmCatalogCache: createCatalogCache(),
      llmEncKey: ENC_KEY,
    };
    const app = await createApp(deps);
    const cookies = await loginAsAdmin(repos, app);
    const res = await app.request('/admin/llm-catalog', {
      headers: { Cookie: cookieHeader(cookies, 'jobagent_session') },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { models?: Array<Record<string, unknown>>; envConfigured?: boolean };
    expect(body.models!).toHaveLength(1);
    expect(body.models![0]).toMatchObject({
      id: 'agnes-2.5-flash',
      provider: 'agnes',
      enabled: true,
      isDefault: true,
    });
    expect(typeof body.envConfigured).toBe('boolean');
  });
});

describe('PUT /admin/llm-catalog（整体替换 + 缓存刷新）', () => {
  it('admin 替换目录后 GET 立即可见（缓存已刷新）', async () => {
    const repos = await createStorage({ sqlitePath: ':memory:' });
    const deps: ApiDeps = {
      repos,
      authConfig: loadAuthConfig({}),
      githubAuthProvider: new FakeAuthProvider(ADMIN),
      llmCatalogCache: createCatalogCache(),
      llmEncKey: ENC_KEY,
    };
    const app = await createApp(deps);
    const cookies = await loginAsAdmin(repos, app);
    const auth = { Cookie: cookieHeader(cookies, 'jobagent_session') };

    const putRes = await app.request('/admin/llm-catalog', {
      method: 'PUT',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({
        models: [
          { id: 'agnes-2.5-flash', provider: 'agnes', model: 'agnes-2.5-flash', enabled: false, isDefault: false, sortOrder: 1, modalities: ['text'] },
          { id: 'm2', provider: 'b', model: 'b-model', enabled: true, isDefault: true, sortOrder: 2, modalities: ['text'] },
        ],
      }),
    });
    expect(putRes.status).toBe(200);
    const putBody = (await putRes.json()) as { models?: Array<Record<string, unknown>> };
    expect(putBody.models!).toHaveLength(2);
    expect(putBody.models![1]).toMatchObject({ id: 'm2', isDefault: true });

    const getRes = await app.request('/admin/llm-catalog', { headers: auth });
    const getBody = (await getRes.json()) as { models?: Array<Record<string, unknown>> };
    expect(getBody.models).toHaveLength(2);
  });

  it('非法负载（缺 sortOrder / 空数组）→ 400', async () => {
    const repos = await createStorage({ sqlitePath: ':memory:' });
    const deps: ApiDeps = {
      repos,
      authConfig: loadAuthConfig({}),
      githubAuthProvider: new FakeAuthProvider(ADMIN),
      llmCatalogCache: createCatalogCache(),
      llmEncKey: ENC_KEY,
    };
    const app = await createApp(deps);
    const cookies = await loginAsAdmin(repos, app);
    const auth = { Cookie: cookieHeader(cookies, 'jobagent_session'), 'content-type': 'application/json' };
    const res = await app.request('/admin/llm-catalog', {
      method: 'PUT',
      headers: auth,
      body: JSON.stringify({ models: [] }),
    });
    expect(res.status).toBe(400);
  });
});

describe('POST /admin/llm-catalog/refresh（显式重读仓储）', () => {
  it('仓储被外部改动后 refresh 使缓存可见', async () => {
    const repos = await createStorage({ sqlitePath: ':memory:' });
    const deps: ApiDeps = {
      repos,
      authConfig: loadAuthConfig({}),
      githubAuthProvider: new FakeAuthProvider(ADMIN),
      llmCatalogCache: createCatalogCache(),
      llmEncKey: ENC_KEY,
    };
    const app = await createApp(deps);
    const cookies = await loginAsAdmin(repos, app);
    const auth = { Cookie: cookieHeader(cookies, 'jobagent_session') };

    // 绕过 API 直接写仓储（模拟外部 DDL/直改）
    await repos.llmCatalog.replaceAll([
      { id: 'ext-1', provider: 'x', model: 'x-1', enabled: true, isDefault: true, sortOrder: 1, modalities: ['text'], createdAt: '2026-10-03T00:00:00.000Z', updatedAt: '2026-10-03T00:00:00.000Z' },
    ]);
    const res = await app.request('/admin/llm-catalog/refresh', { method: 'POST', headers: auth });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { models?: Array<Record<string, unknown>>; envConfigured?: boolean };
    expect(body.models![0]).toMatchObject({ id: 'ext-1' });
  });
});

describe('BYOK /account/llm-config（加密保存 + 掩码回显）', () => {
  it('全链路：404 → PUT 保存 → GET 掩码 → PUT 改配置不换 key → DELETE → 404', async () => {
    const repos = await createStorage({ sqlitePath: ':memory:' });
    const deps: ApiDeps = {
      repos,
      authConfig: loadAuthConfig({}),
      githubAuthProvider: new FakeAuthProvider(BOB),
      llmCatalogCache: createCatalogCache(),
      llmEncKey: ENC_KEY,
    };
    const app = await createApp(deps);
    const cookies = await loginAs(BOB, repos, app);
    const auth = { Cookie: cookieHeader(cookies, 'jobagent_session') };
    const apiKey = 'sk-bob-secret-9876';

    const get0 = await app.request('/account/llm-config', { headers: auth });
    expect(get0.status).toBe(404);

    const put = await app.request('/account/llm-config', {
      method: 'PUT',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ baseUrl: 'https://api.example.com/v1', model: 'm-1', apiKey }),
    });
    expect(put.status).toBe(200);
    const putBody = (await put.json()) as { models?: Array<Record<string, unknown>>; keyMasked?: string; model?: string };
    expect(putBody.keyMasked).toBe('sk-****9876');
    expect(putBody.keyMasked).not.toContain('bob-secret');

    // 落库必须是密文（accountId 经 /auth/me 取，accounts 仓储无 getByLogin）
    const me = await app.request('/auth/me', { headers: auth });
    const meBody = (await me.json()) as { accountId: string; canManageLlmCatalog?: boolean };
    const stored = await repos.userLlmConfigs.getByAccountId(meBody.accountId);
    expect(stored!.apiKeyEncrypted).not.toContain(apiKey);

    const get1 = await app.request('/account/llm-config', { headers: auth });
    expect(((await get1.json()) as { keyMasked?: string }).keyMasked).toBe('sk-****9876');

    // 只换 model，不带 apiKey：沿用旧密钥
    const put2 = await app.request('/account/llm-config', {
      method: 'PUT',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ baseUrl: 'https://api.example.com/v1', model: 'm-2' }),
    });
    const put2Body = (await put2.json()) as { model?: string; keyMasked?: string };
    expect(put2.status).toBe(200);
    expect(put2Body.model).toBe('m-2');
    expect(put2Body.keyMasked).toBe('sk-****9876');

    const del = await app.request('/account/llm-config', { method: 'DELETE', headers: auth });
    expect(del.status).toBe(204);

    const get2 = await app.request('/account/llm-config', { headers: auth });
    expect(get2.status).toBe(404);
  });

  it('LLM_ENC_KEY 未配置 → PUT 503 ENCRYPTION_NOT_CONFIGURED', async () => {
    const repos = await createStorage({ sqlitePath: ':memory:' });
    const deps: ApiDeps = {
      repos,
      authConfig: loadAuthConfig({}),
      githubAuthProvider: new FakeAuthProvider(BOB),
      llmCatalogCache: createCatalogCache(),
      llmEncKey: null,
    };
    const app = await createApp(deps);
    const cookies = await loginAs(BOB, repos, app);
    const res = await app.request('/account/llm-config', {
      method: 'PUT',
      headers: { Cookie: cookieHeader(cookies, 'jobagent_session'), 'content-type': 'application/json' },
      body: JSON.stringify({ baseUrl: 'https://api.example.com/v1', model: 'm', apiKey: 'sk-x' }),
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: 'ENCRYPTION_NOT_CONFIGURED' });
  });

  it('匿名 → 401', async () => {
    const { app } = await setup();
    const res = await app.request('/account/llm-config');
    expect(res.status).toBe(401);
  });
});

describe('POST /account/llm-config/validate（最小真实请求，stub fetch）', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('上游 200 → ok:true，带 provider/model', async () => {
    const repos = await createStorage({ sqlitePath: ':memory:' });
    const deps: ApiDeps = {
      repos,
      authConfig: loadAuthConfig({}),
      githubAuthProvider: new FakeAuthProvider(BOB),
      llmCatalogCache: createCatalogCache(),
      llmEncKey: ENC_KEY,
    };
    const app = await createApp(deps);
    const cookies = await loginAs(BOB, repos, app);

    vi.stubGlobal('fetch', async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const res = await app.request('/account/llm-config/validate', {
      method: 'POST',
      headers: { Cookie: cookieHeader(cookies, 'jobagent_session'), 'content-type': 'application/json' },
      body: JSON.stringify({ baseUrl: 'https://api.example.com/v1', model: 'm', apiKey: 'sk-x' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; provider?: string; model?: string };
    expect(body.ok).toBe(true);
    expect(body.provider).toBeTruthy();
  });

  it('上游 500 → 502 LLM_VALIDATION_FAILED，不回显 key', async () => {
    const repos = await createStorage({ sqlitePath: ':memory:' });
    const deps: ApiDeps = {
      repos,
      authConfig: loadAuthConfig({}),
      githubAuthProvider: new FakeAuthProvider(BOB),
      llmCatalogCache: createCatalogCache(),
      llmEncKey: ENC_KEY,
    };
    const app = await createApp(deps);
    const cookies = await loginAs(BOB, repos, app);

    vi.stubGlobal('fetch', async () => new Response('boom', { status: 500 }));
    const res = await app.request('/account/llm-config/validate', {
      method: 'POST',
      headers: { Cookie: cookieHeader(cookies, 'jobagent_session'), 'content-type': 'application/json' },
      body: JSON.stringify({ baseUrl: 'https://api.example.com/v1', model: 'm', apiKey: 'sk-x' }),
    });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { ok: boolean; code?: string };
    expect(body.ok).toBe(false);
    expect(body.code).toBe('LLM_VALIDATION_FAILED');
  });

  it('缺 apiKey → 400', async () => {
    const repos = await createStorage({ sqlitePath: ':memory:' });
    const deps: ApiDeps = {
      repos,
      authConfig: loadAuthConfig({}),
      githubAuthProvider: new FakeAuthProvider(BOB),
      llmCatalogCache: createCatalogCache(),
      llmEncKey: ENC_KEY,
    };
    const app = await createApp(deps);
    const cookies = await loginAs(BOB, repos, app);
    const res = await app.request('/account/llm-config/validate', {
      method: 'POST',
      headers: { Cookie: cookieHeader(cookies, 'jobagent_session'), 'content-type': 'application/json' },
      body: JSON.stringify({ baseUrl: 'https://api.example.com/v1', model: 'm' }),
    });
    expect(res.status).toBe(400);
  });
});

describe('ADMIN_ACCOUNT_LOGINS 白名单（登录自动置位）', () => {
  it('白名单内的 login 登录后 is_admin=true，/auth/me 回 canManageLlmCatalog=true', async () => {
    const prev = process.env.ADMIN_ACCOUNT_LOGINS;
    process.env.ADMIN_ACCOUNT_LOGINS = 'admin1';
    try {
      const repos = await createStorage({ sqlitePath: ':memory:' });
      const deps: ApiDeps = {
        repos,
        authConfig: loadAuthConfig({}),
        githubAuthProvider: new FakeAuthProvider(ADMIN),
        llmCatalogCache: createCatalogCache(),
        llmEncKey: ENC_KEY,
      };
      const app = await createApp(deps);
      const cookies = await loginAs(ADMIN, repos, app);

      const me = await app.request('/auth/me', {
        headers: { Cookie: cookieHeader(cookies, 'jobagent_session') },
      });
      const meBody = (await me.json()) as { accountId: string; canManageLlmCatalog?: boolean };
      expect(meBody.canManageLlmCatalog).toBe(true);

      // 置位生效的强证明：admin 端点不再 403
      const catalogRes = await app.request('/admin/llm-catalog', {
        headers: { Cookie: cookieHeader(cookies, 'jobagent_session') },
      });
      expect(catalogRes.status).toBe(200);
    } finally {
      if (prev === undefined) delete process.env.ADMIN_ACCOUNT_LOGINS;
      else process.env.ADMIN_ACCOUNT_LOGINS = prev;
    }
  });

  it('白名单外 login → is_admin 保持 false', async () => {
    const prev = process.env.ADMIN_ACCOUNT_LOGINS;
    process.env.ADMIN_ACCOUNT_LOGINS = 'someone-else';
    try {
      const repos = await createStorage({ sqlitePath: ':memory:' });
      const deps: ApiDeps = {
        repos,
        authConfig: loadAuthConfig({}),
        githubAuthProvider: new FakeAuthProvider(BOB),
        llmCatalogCache: createCatalogCache(),
        llmEncKey: ENC_KEY,
      };
      const app = await createApp(deps);
      const cookies = await loginAs(BOB, repos, app);
      const me = await app.request('/auth/me', {
        headers: { Cookie: cookieHeader(cookies, 'jobagent_session') },
      });
      const meBody = (await me.json()) as { accountId: string; canManageLlmCatalog?: boolean };
      expect(meBody.canManageLlmCatalog).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.ADMIN_ACCOUNT_LOGINS;
      else process.env.ADMIN_ACCOUNT_LOGINS = prev;
    }
  });
});

/**
 * U5 请求路由：BYOK 优先 → 内置回落 → 功能既有策略（cover-letter 503）。
 * 完整链路：登录 →（可选）保存 BYOK → POST /resumes/cover-letter，
 * 用 stub global.fetch 记录真实请求目标，证明"每次调用前解析"接线生效。
 */
describe('LLM 请求路由（BYOK 优先 → 内置回落）', () => {
  let fetchStub: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchStub = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const body = JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                subject: 'Re: Senior TypeScript Engineer',
                body: 'I am a TypeScript engineer with evidence-backed experience.',
              }),
            },
          },
        ],
      });
      return new Response(body, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchStub);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function seedResume(repos: StorageContext): Promise<string> {
    await repos.profiles.insert({
      id: 'p-route',
      analyzerVersion: 'schema-0.1-engine-0.2',
      subjectLogin: 'route-user',
      dataWindowSince: '2024-01-01T00:00:00.000Z',
      dataWindowUntil: '2026-09-01T00:00:00.000Z',
      status: 'complete',
      snapshot: {
        profileId: 'p-route',
        analyzerVersion: 'schema-0.1-engine-0.2',
        generatedAt: '2026-09-15T00:00:00.000Z',
        dataWindow: { since: '2024-01-01T00:00:00.000Z', until: '2026-09-01T00:00:00.000Z' },
        analysisLayers: ['L0', 'L1'],
        subject: {
          platform: 'github',
          login: 'route-user',
          displayName: 'Route User',
          profileUrl: 'https://github.com/route-user',
          claimed: false,
        },
        summary: { headline: 'TypeScript engineer' },
        skillTags: [{ name: 'typescript', kind: 'language', depth: 'proficient', confidence: 0.9, evidenceRefs: [] }],
        highlights: [],
        activity: { longevityMonths: 12, metrics: { commitCount: 40 } },
        collaboration: { evidenceRefs: [] },
        authenticity: { status: 'likely_authentic', confidence: 0.8, signals: [] },
        interviewQuestions: [],
        caveats: [],
      },
    });
    await repos.jobPostings.upsertBatch(
      [
        {
          jobId: 'j-route',
          source: 'greenhouse',
          sourceUrl: 'https://example.test/jobs/1',
          title: 'Senior TypeScript Engineer',
          company: 'Acme',
          remote: false,
          postedAt: '2026-09-01T00:00:00.000Z',
          fetchedAt: '2026-09-15T00:00:00.000Z',
          tags: ['typescript'],
          normalizedKey: 'nk-route-1',
        },
      ],
      '2026-09-15T00:00:00.000Z',
    );
    const rows = await repos.jobPostings.search({});
    const job = rows.find((r) => r.title === 'Senior TypeScript Engineer')!;
    return job.id;
  }

  async function postCoverLetter(
    app: Awaited<ReturnType<typeof createApp>>,
    cookies: Record<string, string>,
    jobRowId: string,
  ) {
    return app.request('/resumes/cover-letter', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Cookie: cookieHeader(cookies, 'jobagent_session'),
      },
      body: JSON.stringify({
        profileId: 'p-route',
        jobId: jobRowId,
        locale: 'en',
      }),
    });
  }

  it('BYOK 优先：登录用户保存 BYOK 后，cover-letter 请求打到 BYOK 端点', async () => {
    const repos = await createStorage({ sqlitePath: ':memory:' });
    const jobRowId = await seedResume(repos);
    const deps: ApiDeps = {
      repos,
      authConfig: loadAuthConfig({}),
      githubAuthProvider: new FakeAuthProvider(BOB),
      llmCatalogCache: createCatalogCache(),
      llmEncKey: ENC_KEY,
      coverLetter: null,
    };
    const app = await createApp(deps);
    const cookies = await loginAs(BOB, repos, app);
    await app.request('/account/llm-config', {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        Cookie: cookieHeader(cookies, 'jobagent_session'),
      },
      body: JSON.stringify({
        baseUrl: 'https://byok.example.com/v1',
        model: 'byok-model',
        apiKey: 'sk-byok-key',
      }),
    });

    const res = await postCoverLetter(app, cookies, jobRowId);
    if (res.status !== 200) console.error('BYOK res:', res.status, await res.text());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { provenance: { provider: string; model: string } };
    expect(body.provenance.provider).toBe('custom');
    expect(body.provenance.model).toBe('byok-model');

    const [url, init] = fetchStub.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe('https://byok.example.com/v1/chat/completions');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer sk-byok-key');
  });

  it('内置回落：未配 BYOK → 用服务端内置 provider（注入 fake）', async () => {
    const repos = await createStorage({ sqlitePath: ':memory:' });
    const jobRowId = await seedResume(repos);
    const deps: ApiDeps = {
      repos,
      authConfig: loadAuthConfig({}),
      githubAuthProvider: new FakeAuthProvider(BOB),
      llmCatalogCache: createCatalogCache(),
      llmEncKey: ENC_KEY,
      coverLetter: new LlmCoverLetterProvider(new FakeLlmClient(() => ({
        subject: 'Re: role',
        body: 'Builtin draft body.',
      }))),
    };
    const app = await createApp(deps);
    const cookies = await loginAs(BOB, repos, app);

    const res = await postCoverLetter(app, cookies, jobRowId);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { provenance: { provider: string } };
    expect(body.provenance.provider).toBe('fake');
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it('两者都无 → 503 LLM_NOT_CONFIGURED（不伪造求职信）', async () => {
    const repos = await createStorage({ sqlitePath: ':memory:' });
    const jobRowId = await seedResume(repos);
    const deps: ApiDeps = {
      repos,
      authConfig: loadAuthConfig({}),
      githubAuthProvider: new FakeAuthProvider(BOB),
      llmCatalogCache: createCatalogCache(),
      llmEncKey: ENC_KEY,
      coverLetter: null,
    };
    const app = await createApp(deps);
    const cookies = await loginAs(BOB, repos, app);

    const res = await postCoverLetter(app, cookies, jobRowId);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: 'LLM_NOT_CONFIGURED' });
  });
});
