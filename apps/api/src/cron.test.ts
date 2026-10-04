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
    const app = await createApp({ repos: await freshRepos(), processJobOnce });

    const res = await app.request('/internal/cron/process-job', {
      headers: { authorization: `Bearer ${SECRET}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; outcome: unknown };
    expect(body.ok).toBe(true);
    expect(body.outcome).toEqual({ kind: 'processed', jobId: 'job-1', profileId: 'prof-1' });
    expect(processJobOnce).toHaveBeenCalledOnce();
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
