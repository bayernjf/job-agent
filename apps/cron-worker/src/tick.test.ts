/**
 * Unit tests for the cron worker decision core. The getter and sleeper are
 * fakes, so the drain/error semantics are verified without a network or a
 * deployed Worker.
 */
import { describe, expect, it, vi } from 'vitest';
import { runCronTick, type CronEnv } from './tick.js';

const env: CronEnv = {
  PROD_ORIGIN: 'https://app.job-agent.bayjf.com',
  CRON_SECRET: 'test-secret',
  DRAIN_LIMIT: 3,
};

const idle = JSON.stringify({ outcome: { kind: 'idle' } });
const processed = JSON.stringify({ outcome: { kind: 'processed' } });

interface Call {
  path: string;
  status?: number;
  body: string;
}

function makeGetter(responses: Array<Pick<Call, 'status' | 'body'>>) {
  const calls: { path: string }[] = [];
  let i = 0;
  const get = vi.fn(async (path: string) => {
    calls.push({ path });
    const r = responses[Math.min(i, responses.length - 1)]!;
    i++;
    return { status: r.status ?? 200, body: r.body };
  });
  return { get, calls };
}

const sleep = vi.fn(async () => {});

it('drains until idle and then advances agent-tick', async () => {
  const { get, calls } = makeGetter([
    { body: processed },
    { body: processed },
    { body: idle },
    { body: idle },
  ]);

  const log = await runCronTick(env, get, sleep);

  expect(log.processJob.processed).toBe(2);
  expect(log.processJob.idle).toBe(true);
  expect(log.agentTick.status).toBe(200);
  expect(calls.map((c) => c.path)).toEqual([
    '/api/internal/cron/process-job',
    '/api/internal/cron/process-job',
    '/api/internal/cron/process-job',
    '/api/internal/cron/agent-tick',
  ]);
});

it('returns idle immediately on an empty queue (one process-job + agent-tick)', async () => {
  const { get, calls } = makeGetter([{ body: idle }, { body: idle }]);
  const log = await runCronTick(env, get, sleep);

  expect(log.processJob).toEqual({ processed: 0, idle: true });
  expect(calls).toHaveLength(2);
});

it('stops without swallowing a non-2xx from process-job', async () => {
  const { get, calls } = makeGetter([{ status: 401, body: 'unauthorized' }]);
  const log = await runCronTick(env, get, sleep);

  expect(log.processJob.status).toBe(401);
  expect(log.processJob.idle).toBe(false);
  expect(log.agentTick).toEqual({ ok: false });
  expect(calls).toHaveLength(1);
});

it('still runs agent-tick when the drain cap is reached', async () => {
  const { get, calls } = makeGetter([{ body: processed }, { body: '{"ok":true}' }]);
  const log = await runCronTick(env, get, sleep);

  expect(log.processJob.processed).toBe(3);
  expect(log.processJob.idle).toBe(false);
  expect(log.agentTick.status).toBe(200);
  expect(calls.at(-1)!.path).toBe('/api/internal/cron/agent-tick');
});

it('treats an unparseable 200 body as a processed answer, not a crash', async () => {
  const { get } = makeGetter([{ body: 'not json' }, { body: idle }, { body: idle }]);
  const log = await runCronTick(env, get, sleep);

  expect(log.processJob.processed).toBe(1);
  expect(log.processJob.idle).toBe(true);
});
