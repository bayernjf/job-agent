/**
 * 触达通道 API 集成测试（决策 #25）。
 *
 * 覆盖：登录闸、email-digest 开启（显式邮箱 / 回落 accounts.email / 无邮箱 400）
 * 与关闭、web-push upsert + 删除、vapid-key 未配置 503、digest-tick 聚合
 * （窗口内 pending 才产信、零候选不产信、digest-sent 回写推进窗口）。
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
  providerAccountId: '911',
  login: 'noti-alice',
  name: 'Alice',
  email: 'alice@example.com',
  avatarUrl: null,
};
const NOEMAIL: OAuthProfile = {
  platform: 'github',
  providerAccountId: '912',
  login: 'noti-noemail',
  name: 'NoEmail',
  email: null,
  avatarUrl: null,
};

const CRON_SECRET = 'noti-test-secret';
let previousCronSecret: string | undefined;
beforeAll(() => {
  previousCronSecret = process.env.CRON_SECRET;
  process.env.CRON_SECRET = CRON_SECRET;
  delete process.env.VAPID_PUBLIC_KEY;
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

async function harness(user: OAuthProfile = ALICE) {
  const repos = await createStorage({ sqlitePath: ':memory:' });
  const deps: ApiDeps = {
    repos,
    authConfig: loadAuthConfig({}),
    githubAuthProvider: new FakeAuthProvider(user),
  };
  const app = await createApp(deps);
  const loginRes = await app.request('/auth/github/login');
  const state = extractCookies(loginRes).jobagent_oauth_state;
  const cb = await app.request(
    `/auth/github/callback?state=${encodeURIComponent(state!)}&code=fake-code`,
    { headers: { Cookie: `jobagent_oauth_state=${state!}` } },
  );
  const session = extractCookies(cb).jobagent_session;
  return { repos, app, Cookie: `jobagent_session=${session!}` };
}

const cronHeaders = { authorization: `Bearer ${CRON_SECRET}` };

describe('notification settings', () => {
  it('requires login for all settings endpoints', async () => {
    const { app } = await harness();
    expect((await app.request('/agent/notifications')).status).toBe(401);
    expect(
      (
        await app.request('/agent/notifications/email-digest', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: true }),
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await app.request('/agent/notifications/web-push', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ endpoint: 'https://push.example/ep', keys: { p256dh: 'k', auth: 'a' } }),
        })
      ).status,
    ).toBe(401);
  });

  it('email digest: enable falls back to account email, disable deletes the row', async () => {
    const { app, Cookie } = await harness();
    const put = await app.request('/agent/notifications/email-digest', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie },
      body: JSON.stringify({ enabled: true }),
    });
    expect(put.status).toBe(200);
    const body = (await put.json()) as { enabled: boolean; email: string };
    expect(body.enabled).toBe(true);
    expect(body.email).toBe('alice@example.com');

    const list = await app.request('/agent/notifications', { headers: { Cookie } });
    const subs = ((await list.json()) as { subscriptions: Array<{ channel: string; endpoint: string }> }).subscriptions;
    expect(subs).toHaveLength(1);
    expect(subs[0]).toMatchObject({ channel: 'email_digest', endpoint: 'alice@example.com' });

    const off = await app.request('/agent/notifications/email-digest', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie },
      body: JSON.stringify({ enabled: false }),
    });
    expect(off.status).toBe(200);
    const after = await app.request('/agent/notifications', { headers: { Cookie } });
    expect(((await after.json()) as { subscriptions: unknown[] }).subscriptions).toHaveLength(0);
  });

  it('email digest: no account email and no explicit email -> 400 EMAIL_REQUIRED', async () => {
    const { app, Cookie } = await harness(NOEMAIL);
    const res = await app.request('/agent/notifications/email-digest', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie },
      body: JSON.stringify({ enabled: true }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('EMAIL_REQUIRED');

    const ok = await app.request('/agent/notifications/email-digest', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie },
      body: JSON.stringify({ enabled: true, email: 'me@example.org' }),
    });
    expect(ok.status).toBe(200);
  });

  it('web push: upsert keeps keys server-side and delete removes the row', async () => {
    const { app, Cookie } = await harness();
    const post = await app.request('/agent/notifications/web-push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie },
      body: JSON.stringify({ endpoint: 'https://push.example/ep1', keys: { p256dh: 'k1', auth: 'a1' } }),
    });
    expect(post.status).toBe(200);

    const list = await app.request('/agent/notifications', { headers: { Cookie } });
    const subs = ((await list.json()) as { subscriptions: Array<Record<string, unknown>> }).subscriptions;
    expect(subs).toHaveLength(1);
    expect(subs[0]).toMatchObject({ channel: 'web_push', endpoint: 'https://push.example/ep1' });
    expect(subs[0]).not.toHaveProperty('keys');

    const del = await app.request('/agent/notifications/web-push', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', Cookie },
      body: JSON.stringify({ endpoint: 'https://push.example/ep1' }),
    });
    expect(del.status).toBe(200);
    const after = await app.request('/agent/notifications', { headers: { Cookie } });
    expect(((await after.json()) as { subscriptions: unknown[] }).subscriptions).toHaveLength(0);
  });

  it('vapid-key is an honest 503 when VAPID_PUBLIC_KEY is not configured', async () => {
    const { app, Cookie } = await harness();
    const res = await app.request('/agent/notifications/vapid-key', { headers: { Cookie } });
    expect(res.status).toBe(503);
  });
});

describe('digest-tick', () => {
  it('produces a digest only for subscriptions with new pending candidates, and digest-sent advances the window', async () => {
    const { repos, app, Cookie } = await harness();
    // Alice enables the digest
    await app.request('/agent/notifications/email-digest', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie },
      body: JSON.stringify({ enabled: true }),
    });
    const aliceAccount = (await repos.accounts.getByProvider('github', '911'))!;

    // No candidates yet -> no digest, and no window advance
    const empty = await app.request('/internal/cron/digest-tick', { headers: cronHeaders });
    expect(empty.status).toBe(200);
    expect(((await empty.json()) as { digests: unknown[] }).digests).toHaveLength(0);

    // Seed a pending intent inside the window
    const nowIso = new Date().toISOString();
    await repos.submitIntents.insert({
      id: 'intent-n1',
      runId: 'run-n1',
      accountId: aliceAccount.id,
      profileId: 'prof-n1',
      jobId: 'job-n1',
      jobSource: 'remotive',
      job: {
        jobId: 'job-n1',
        source: 'remotive',
        sourceUrl: 'https://remotive.example/job-n1',
        title: 'Backend Engineer',
        company: 'Acme',
        remote: true,
        tags: [],
        postedAt: nowIso,
      },
      matchScore: 9,
      matchTier: 'high',
      report: { version: 1, matched: [], gaps: [] } as never,
      status: 'pending',
      createdAt: nowIso,
      updatedAt: nowIso,
    });

    const tick = await app.request('/internal/cron/digest-tick', { headers: cronHeaders });
    const digests = ((await tick.json()) as { digests: Array<{ subscriptionId: string; to: string; text: string }> }).digests;
    expect(digests).toHaveLength(1);
    expect(digests[0]?.to).toBe('alice@example.com');
    expect(digests[0]?.text).toContain('Backend Engineer');

    const sent = await app.request('/internal/cron/digest-sent', {
      method: 'POST',
      headers: { ...cronHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscriptionIds: [digests[0]?.subscriptionId] }),
    });
    expect(sent.status).toBe(200);
    const subs = await repos.notificationSubscriptions.listByAccount(aliceAccount.id);
    expect(subs[0]?.lastSentAt).not.toBeNull();

    // Window advanced: the same intent is now older than lastSentAt -> no digest
    const after = await app.request('/internal/cron/digest-tick', { headers: cronHeaders });
    expect(((await after.json()) as { digests: unknown[] }).digests).toHaveLength(0);
  });

  it('rejects unauthorized callers', async () => {
    const { app } = await harness();
    expect((await app.request('/internal/cron/digest-tick')).status).toBe(401);
  });
});
