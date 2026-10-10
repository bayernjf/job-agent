/**
 * 内部定时任务端点测试（serverless 部署，2026-09-20）：
 * - 未带凭证 → 401
 * - CRON_SECRET 配置后，Authorization: Bearer 错误/正确（Vercel Cron 自动注入的形态）
 * - 历史形态 `?token=` 即使值正确也 401（2026-10-05 停用：密钥不该留在 URL 与访问日志里）
 * - CRON_SECRET 配置后，Authorization: Bearer 错误/正确（Vercel Cron 自动注入的形态）
 * - 未配置 secret 时接受平台 x-vercel-cron: 1 头
 * - process-job 透传 worker 结果；cleanup 校验 task 并调用注入的 maintenance
 *
 * 全部用内存仓储 + 注入 fake，不打真实采集、不真实删数据。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStorage, type StorageContext } from '@jobagent/storage';
import { createApp } from './index.js';

async function freshRepos(): Promise<StorageContext> {
  return createStorage({ sqlitePath: ':memory:' });
}

const SECRET = 'cron-secret-test';

afterEach(() => {
  delete process.env.CRON_SECRET;
});

describe('GET /internal/cron/process-job', () => {
  it('rejects requests without any cron credential (401)', async () => {
    const app = await createApp({ repos: await freshRepos() });
    const res = await app.request('/internal/cron/process-job');
    expect(res.status).toBe(401);
  });

  it('rejects a wrong bearer token when CRON_SECRET is configured', async () => {
    process.env.CRON_SECRET = SECRET;
    const processJobOnce = vi.fn(async () => ({ kind: 'idle' as const }));
    const app = await createApp({ repos: await freshRepos(), processJobOnce });

    const res = await app.request('/internal/cron/process-job', {
      headers: { authorization: 'Bearer wrong' },
    });
    expect(res.status).toBe(401);
    expect(processJobOnce).not.toHaveBeenCalled();
  });

  it('rejects the retired ?token= form even when the value is correct', async () => {
    // 2026-10-05 停用：URL 里的共享密钥会留在访问日志、代理记录与命令行回显里。
    // 这条是"形态已死"的正向钉——闸若恢复接受 query，本用例即红。
    process.env.CRON_SECRET = SECRET;
    const processJobOnce = vi.fn(async () => ({ kind: 'idle' as const }));
    const app = await createApp({ repos: await freshRepos(), processJobOnce });

    const res = await app.request(`/internal/cron/process-job?token=${SECRET}`);
    expect(res.status).toBe(401);
    expect(processJobOnce).not.toHaveBeenCalled();
  });

  it('accepts the correct bearer token and returns the worker outcome', async () => {
    process.env.CRON_SECRET = SECRET;
    const processJobOnce = vi.fn(async () => ({
      kind: 'processed' as const,
      jobId: 'job-1',
      profileId: 'prof-1',
    }));
    const repos = await freshRepos();
    const app = await createApp({ repos, processJobOnce });

    const res = await app.request('/internal/cron/process-job', {
      headers: { authorization: `Bearer ${SECRET}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; outcome: unknown };
    expect(body.ok).toBe(true);
    expect(body.outcome).toEqual({ kind: 'processed', jobId: 'job-1', profileId: 'prof-1' });
    expect(processJobOnce).toHaveBeenCalledOnce();

    // 心跳回写：成功消费 → last_success_at 记录、无 last_error
    const beats = await repos.cronHeartbeat.listAll();
    expect(beats).toEqual([
      {
        consumer: 'process-job',
        lastSuccessAt: expect.any(String),
        lastResult: 'processed=job-1',
        lastError: null,
        updatedAt: expect.any(String),
      },
    ]);
  });

  it('records idle outcome as a successful heartbeat', async () => {
    process.env.CRON_SECRET = SECRET;
    const processJobOnce = vi.fn(async () => ({ kind: 'idle' as const }));
    const repos = await freshRepos();
    const app = await createApp({ repos, processJobOnce });

    const res = await app.request('/internal/cron/process-job', {
      headers: { authorization: `Bearer ${SECRET}` },
    });
    expect(res.status).toBe(200);
    const beat = (await repos.cronHeartbeat.listAll())[0]!;
    expect(beat.consumer).toBe('process-job');
    expect(beat.lastResult).toBe('idle');
    expect(beat.lastError).toBeNull();
  });

  it('records a failed outcome into last_error without overwriting the last success', async () => {
    process.env.CRON_SECRET = SECRET;
    const repos = await freshRepos();
    await repos.cronHeartbeat.recordSuccess('process-job', '2026-10-07T04:00:00.000Z', 'idle');
    const processJobOnce = vi.fn(async () => ({
      kind: 'failed' as const,
      jobId: 'job-9',
      permanent: true,
      message: 'analysis rejected',
    }));
    const app = await createApp({ repos, processJobOnce });

    const res = await app.request('/internal/cron/process-job', {
      headers: { authorization: `Bearer ${SECRET}` },
    });
    expect(res.status).toBe(200);
    const beat = (await repos.cronHeartbeat.listAll())[0]!;
    expect(beat.lastSuccessAt).toBe('2026-10-07T04:00:00.000Z'); // 保留最后一次成功
    expect(beat.lastError).toBe('analysis rejected');
  });

  it('records a thrown runner error as heartbeat failure and returns 500', async () => {
    process.env.CRON_SECRET = SECRET;
    const repos = await freshRepos();
    const processJobOnce = vi.fn(async () => {
      throw new Error('GITHUB_TOKEN missing');
    });
    const app = await createApp({ repos, processJobOnce });

    const res = await app.request('/internal/cron/process-job', {
      headers: { authorization: `Bearer ${SECRET}` },
    });
    expect(res.status).toBe(500);
    const beat = (await repos.cronHeartbeat.listAll())[0]!;
    expect(beat.lastError).toBe('GITHUB_TOKEN missing');
  });

  it('accepts Authorization: Bearer <CRON_SECRET> (the header Vercel Cron injects)', async () => {
    process.env.CRON_SECRET = SECRET;
    const processJobOnce = vi.fn(async () => ({ kind: 'idle' as const }));
    const app = await createApp({ repos: await freshRepos(), processJobOnce });

    const res = await app.request('/internal/cron/process-job', {
      headers: { authorization: `Bearer ${SECRET}` },
    });
    expect(res.status).toBe(200);
    expect(processJobOnce).toHaveBeenCalledOnce();
  });

  it('rejects a wrong Authorization header when CRON_SECRET is configured', async () => {
    process.env.CRON_SECRET = SECRET;
    const processJobOnce = vi.fn(async () => ({ kind: 'idle' as const }));
    const app = await createApp({ repos: await freshRepos(), processJobOnce });

    for (const authorization of [`Bearer wrong`, `Basic ${SECRET}`, `Bearer ${SECRET}extra`]) {
      const res = await app.request('/internal/cron/process-job', { headers: { authorization } });
      expect(res.status).toBe(401);
    }
    expect(processJobOnce).not.toHaveBeenCalled();
  });

  it('accepts the platform x-vercel-cron header when no secret is set', async () => {
    const processJobOnce = vi.fn(async () => ({ kind: 'idle' as const }));
    const app = await createApp({ repos: await freshRepos(), processJobOnce });

    const res = await app.request('/internal/cron/process-job', {
      headers: { 'x-vercel-cron': '1' },
    });
    expect(res.status).toBe(200);
    expect(processJobOnce).toHaveBeenCalledOnce();
  });

  it('returns 500 with the message when the worker runner throws (e.g. missing token)', async () => {
    process.env.CRON_SECRET = SECRET;
    const processJobOnce = vi.fn(async () => {
      throw new Error('GITHUB_TOKEN is not set.');
    });
    const app = await createApp({ repos: await freshRepos(), processJobOnce });

    const res = await app.request('/internal/cron/process-job', {
      headers: { authorization: `Bearer ${SECRET}` },
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain('GITHUB_TOKEN');
  });
});

describe('GET /internal/cron/cleanup', () => {
  it('rejects unauthenticated requests', async () => {
    const app = await createApp({ repos: await freshRepos() });
    const res = await app.request('/internal/cron/cleanup');
    expect(res.status).toBe(401);
  });

  it('runs the cleanup cron via Authorization: Bearer (vercel.json path carries no token)', async () => {
    process.env.CRON_SECRET = SECRET;
    const runMaintenance = vi.fn(async (task: string) => ({ task, demoSessions: 1 }));
    const app = await createApp({ repos: await freshRepos(), runMaintenance });

    const res = await app.request('/internal/cron/cleanup?task=all', {
      headers: { authorization: `Bearer ${SECRET}` },
    });
    expect(res.status).toBe(200);
    expect(runMaintenance).toHaveBeenCalledWith('all', expect.any(String));
  });

  it('rejects an unknown task value', async () => {
    process.env.CRON_SECRET = SECRET;
    const runMaintenance = vi.fn(async () => ({}));
    const app = await createApp({ repos: await freshRepos(), runMaintenance });

    const res = await app.request('/internal/cron/cleanup?task=bogus', {
      headers: { authorization: `Bearer ${SECRET}` },
    });
    expect(res.status).toBe(400);
    expect(runMaintenance).not.toHaveBeenCalled();
  });

  it('defaults task to all and passes it to the maintenance runner', async () => {
    process.env.CRON_SECRET = SECRET;
    const runMaintenance = vi.fn(async (task: string) => ({ task, demoSessions: 2 }));
    const app = await createApp({ repos: await freshRepos(), runMaintenance });

    const res = await app.request('/internal/cron/cleanup', {
      headers: { authorization: `Bearer ${SECRET}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; result: { task: string } };
    expect(body.ok).toBe(true);
    expect(runMaintenance).toHaveBeenCalledWith('all', expect.any(String));
    expect(body.result.task).toBe('all');
  });

  it('runs the real maintenance logic against in-memory repos when not injected', async () => {
    process.env.CRON_SECRET = SECRET;
    const app = await createApp({ repos: await freshRepos() });

    const res = await app.request('/internal/cron/cleanup?task=all', {
      headers: { authorization: `Bearer ${SECRET}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      result: Record<string, number>;
    };
    expect(body.ok).toBe(true);
    expect(body.result.demoSessions).toBe(0);
    expect(body.result.authSessions).toBe(0);
  });
});

describe('GET /health?deep=1 (cron heartbeat readout)', () => {
  it('returns cronHeartbeat rows alongside the db probe', async () => {
    const repos = await freshRepos();
    await repos.cronHeartbeat.recordSuccess('process-job', '2026-10-07T04:00:00.000Z', 'idle');
    await repos.cronHeartbeat.recordFailure('agent-tick', '2026-10-07T04:05:00.000Z', 'boom');
    const app = await createApp({ repos });

    const res = await app.request('/health?deep=1');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      db: string;
      cronHeartbeat: Array<{ consumer: string; lastError: string | null }>;
    };
    expect(body.status).toBe('ok');
    expect(body.db).toBe('ok');
    expect(body.cronHeartbeat).toMatchObject([
      { consumer: 'agent-tick', lastError: 'boom' },
      { consumer: 'process-job', lastError: null },
    ]);
  });

  it('keeps the shallow probe free of the heartbeat readout', async () => {
    const app = await createApp({ repos: await freshRepos() });
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.cronHeartbeat).toBeUndefined();
  });
});

describe('GET /health?deep=1 (migration drift guard)', () => {
  it('returns 503 with the missing list when a required column is absent', async () => {
    const repos = await freshRepos();
    const app = await createApp({
      repos: {
        ...repos,
        verifyRequiredColumns: async () => ['claim_verifications.id', 'accounts.is_admin'],
      } as StorageContext,
    });

    const res = await app.request('/health?deep=1');
    expect(res.status).toBe(503);
    const body = (await res.json()) as {
      status: string;
      db: string;
      schemaDrift: string[];
    };
    expect(body.status).toBe('error');
    expect(body.db).toBe('ok'); // DB 可达，漂移是另一回事
    expect(body.schemaDrift).toEqual(['claim_verifications.id', 'accounts.is_admin']);
  });

  it('does not run the drift guard on the shallow probe', async () => {
    const repos = await freshRepos();
    const verifyRequiredColumns = vi.fn(async () => []);
    const app = await createApp({
      repos: { ...repos, verifyRequiredColumns } as StorageContext,
    });

    const res = await app.request('/health');
    expect(res.status).toBe(200);
    expect(verifyRequiredColumns).not.toHaveBeenCalled();
  });
});

describe('GET /internal/cron/watch-heartbeat (liveness watchdog)', () => {
  const auth = { headers: { authorization: 'Bearer watch-secret' } };

  it('rejects requests without any cron credential', async () => {
    process.env.CRON_SECRET = 'watch-secret';
    const app = await createApp({ repos: await freshRepos() });
    const res = await app.request('/internal/cron/watch-heartbeat');
    expect(res.status).toBe(401);
  });

  it('passes on an empty heartbeat table (no consumers yet, nothing to flag)', async () => {
    process.env.CRON_SECRET = 'watch-secret';
    const repos = await freshRepos();
    const app = await createApp({ repos });

    const res = await app.request('/internal/cron/watch-heartbeat', auth);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; heartbeats: unknown[] };
    expect(body.status).toBe('ok');
    expect(body.heartbeats).toEqual([]);
    const watchdog = (await repos.cronHeartbeat.listAll()).find((hb) => hb.consumer === 'watchdog');
    expect(watchdog?.lastError).toBeNull();
    expect(watchdog?.lastResult).toBe('no-consumers-yet');
  });

  it('flags a stale consumer (last success older than threshold) with 503 and writes a watchdog failure', async () => {
    process.env.CRON_SECRET = 'watch-secret';
    const repos = await freshRepos();
    const staleAt = new Date(Date.now() - 16 * 60_000).toISOString();
    await repos.cronHeartbeat.recordSuccess('agent-tick', staleAt, 'advanced=1,recycled=0');
    const app = await createApp({ repos });

    const res = await app.request('/internal/cron/watch-heartbeat', auth);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { status: string; stale: string[] };
    expect(body.status).toBe('error');
    expect(body.stale[0]).toContain('agent-tick');
    const watchdog = (await repos.cronHeartbeat.listAll()).find((hb) => hb.consumer === 'watchdog');
    expect(watchdog?.lastError).toContain('agent-tick');
  });

  it('passes when every known consumer is fresh and clears the watchdog failure', async () => {
    process.env.CRON_SECRET = 'watch-secret';
    const repos = await freshRepos();
    const freshAt = new Date().toISOString();
    await repos.cronHeartbeat.recordSuccess('agent-tick', freshAt, 'advanced=0,recycled=0');
    await repos.cronHeartbeat.recordSuccess('process-job', freshAt, 'idle');
    const app = await createApp({ repos });

    const res = await app.request('/internal/cron/watch-heartbeat', auth);
    expect(res.status).toBe(200);
    const watchdog = (await repos.cronHeartbeat.listAll()).find((hb) => hb.consumer === 'watchdog');
    expect(watchdog?.lastError).toBeNull();
    expect(watchdog?.lastResult).toContain('agent-tick:ok');
  });

  it('ignores unknown consumers instead of flagging them', async () => {
    process.env.CRON_SECRET = 'watch-secret';
    const repos = await freshRepos();
    await repos.cronHeartbeat.recordSuccess('some-future-consumer', new Date(0).toISOString(), 'old');
    const app = await createApp({ repos });

    const res = await app.request('/internal/cron/watch-heartbeat', auth);
    expect(res.status).toBe(200);
  });

  it('deep health returns 503 while the watchdog reports a recent stale', async () => {
    process.env.CRON_SECRET = 'watch-secret';
    const repos = await freshRepos();
    await repos.cronHeartbeat.recordSuccess('agent-tick', new Date(Date.now() - 16 * 60_000).toISOString(), 'old');
    const app = await createApp({ repos });

    const watchRes = await app.request('/internal/cron/watch-heartbeat', auth);
    expect(watchRes.status).toBe(503);

    const deepRes = await app.request('/health?deep=1');
    expect(deepRes.status).toBe(503);
    const body = (await deepRes.json()) as { watchdog: { status: string; message: string } };
    expect(body.watchdog.status).toBe('error');
    expect(body.watchdog.message).toContain('agent-tick');
  });

  it('deep health recovers to 200 once the watchdog succeeds again', async () => {
    process.env.CRON_SECRET = 'watch-secret';
    const repos = await freshRepos();
    await repos.cronHeartbeat.recordSuccess('agent-tick', new Date(Date.now() - 16 * 60_000).toISOString(), 'old');
    const app = await createApp({ repos });

    await app.request('/internal/cron/watch-heartbeat', auth);
    const freshAt = new Date().toISOString();
    await repos.cronHeartbeat.recordSuccess('agent-tick', freshAt, 'ok');
    await app.request('/internal/cron/watch-heartbeat', auth);

    const deepRes = await app.request('/health?deep=1');
    expect(deepRes.status).toBe(200);
  });

  // 自动告警（deferred「Cron Worker 的失败信号没有任何读者」闭环）：stale 翻转边沿
  // 推 Web Push、持续 stale 不重复推、恢复后再 stale 再推、无订阅不推。
  function seedWebPush(repos: StorageContext): Promise<unknown> {
    // 034 迁移对 notification_subscriptions.account_id 有 FK → accounts，先落一行账号
    return repos.accounts
      .upsertFromProvider({
        id: 'acc-alert-1',
        identity: {
          platform: 'github',
          providerAccountId: 'alert-1',
          login: 'alert-owner',
          name: 'Alert Owner',
          email: null,
          avatarUrl: null,
        },
      })
      .then(() =>
        repos.notificationSubscriptions.upsert({
          id: 'nsub-alert-1',
          accountId: 'acc-alert-1',
          channel: 'web_push',
          endpoint: 'https://push.example/ep1',
          keys: { p256dh: 'k1', auth: 'a1' },
          createdAt: new Date().toISOString(),
        }),
      );
  }

  it('pushes a Web Push alert on the fresh→stale edge (first stale round)', async () => {
    process.env.CRON_SECRET = 'watch-secret';
    const repos = await freshRepos();
    await seedWebPush(repos);
    await repos.cronHeartbeat.recordSuccess(
      'agent-tick',
      new Date(Date.now() - 16 * 60_000).toISOString(),
      'advanced=1,recycled=0',
    );
    const sendWebPush = vi.fn(
      async (..._args: Parameters<typeof import('./web-push.js').sendWebPush>) => [
        { subscriptionId: 'nsub-alert-1', ok: true, gone: false },
      ],
    );
    const app = await createApp({ repos, sendWebPush });

    const res = await app.request('/internal/cron/watch-heartbeat', auth);
    expect(res.status).toBe(503);
    expect(sendWebPush).toHaveBeenCalledOnce();
    const payload = sendWebPush.mock.calls[0]?.[1] as { title: string; body: string };
    expect(payload.title).toContain('服务告警');
    expect(payload.body).toContain('agent-tick');
  });

  it('does not re-push while the same stale persists (watchdog lastError already set)', async () => {
    process.env.CRON_SECRET = 'watch-secret';
    const repos = await freshRepos();
    await seedWebPush(repos);
    await repos.cronHeartbeat.recordSuccess(
      'agent-tick',
      new Date(Date.now() - 16 * 60_000).toISOString(),
      'advanced=1,recycled=0',
    );
    const sendWebPush = vi.fn(
      async (..._args: Parameters<typeof import('./web-push.js').sendWebPush>) => [
        { subscriptionId: 'nsub-alert-1', ok: true, gone: false },
      ],
    );
    const app = await createApp({ repos, sendWebPush });

    const first = await app.request('/internal/cron/watch-heartbeat', auth);
    expect(first.status).toBe(503);
    expect(sendWebPush).toHaveBeenCalledOnce();

    // 同一 stale 持续（agent-tick 心跳仍未更新）：第二、三轮不再打扰
    const second = await app.request('/internal/cron/watch-heartbeat', auth);
    expect(second.status).toBe(503);
    const third = await app.request('/internal/cron/watch-heartbeat', auth);
    expect(third.status).toBe(503);
    expect(sendWebPush).toHaveBeenCalledOnce();
  });

  it('re-pushes after recovery (stale → fresh → stale is a new event)', async () => {
    process.env.CRON_SECRET = 'watch-secret';
    const repos = await freshRepos();
    await seedWebPush(repos);
    const sendWebPush = vi.fn(
      async (..._args: Parameters<typeof import('./web-push.js').sendWebPush>) => [
        { subscriptionId: 'nsub-alert-1', ok: true, gone: false },
      ],
    );
    const app = await createApp({ repos, sendWebPush });

    // 第一段 stale
    await repos.cronHeartbeat.recordSuccess(
      'agent-tick',
      new Date(Date.now() - 16 * 60_000).toISOString(),
      'old',
    );
    expect((await app.request('/internal/cron/watch-heartbeat', auth)).status).toBe(503);
    expect(sendWebPush).toHaveBeenCalledOnce();

    // 恢复
    await repos.cronHeartbeat.recordSuccess('agent-tick', new Date().toISOString(), 'ok');
    expect((await app.request('/internal/cron/watch-heartbeat', auth)).status).toBe(200);

    // 再次 stale = 新事件
    await repos.cronHeartbeat.recordSuccess(
      'agent-tick',
      new Date(Date.now() - 16 * 60_000).toISOString(),
      'old-again',
    );
    expect((await app.request('/internal/cron/watch-heartbeat', auth)).status).toBe(503);
    expect(sendWebPush).toHaveBeenCalledTimes(2);
  });

  it('skips push when no web_push subscription exists', async () => {
    process.env.CRON_SECRET = 'watch-secret';
    const repos = await freshRepos();
    await repos.cronHeartbeat.recordSuccess(
      'agent-tick',
      new Date(Date.now() - 16 * 60_000).toISOString(),
      'old',
    );
    const sendWebPush = vi.fn(
      async (..._args: Parameters<typeof import('./web-push.js').sendWebPush>) => [],
    );
    const app = await createApp({ repos, sendWebPush });

    const res = await app.request('/internal/cron/watch-heartbeat', auth);
    expect(res.status).toBe(503);
    expect(sendWebPush).not.toHaveBeenCalled();
  });
});
