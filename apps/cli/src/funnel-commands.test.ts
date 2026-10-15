/**
 * `jobagent funnel summary|daily` 子命令测试（design-funnel-analytics-20261015 §6 读口）。
 * 内存 SQLite 直插 funnel_events，零网络：覆盖 table 默认 / json 格式、
 * 窗口边界、空窗口、参数错误退出码与未知子命令。
 */
import { describe, expect, it } from 'vitest';
import { createStorage, type StorageContext } from '@jobagent/storage';
import { run, type CliDeps } from './index.js';

async function harness(): Promise<{
  storage: StorageContext;
  deps: CliDeps;
  out: () => string;
  err: () => string;
}> {
  let out = '';
  let err = '';
  const storage = await createStorage({ sqlitePath: ':memory:' });
  const deps: CliDeps = {
    storage,
    now: () => '2026-10-15T00:00:00.000Z',
    stdout: { write: (c: string) => void (out += c) },
    logger: {
      log: () => undefined,
      info: () => undefined,
      warn: (m: string) => void (err += `${m}\n`),
      error: (m: string) => void (err += `${m}\n`),
    },
  };
  return { storage, deps, out: () => out, err: () => err };
}

const P1 = '11111111-1111-4111-8111-111111111111';

async function seed(storage: StorageContext): Promise<void> {
  await storage.funnelEvents.insert({
    id: 'fe-1',
    event: 'analyze_enqueued',
    sessionRef: 'sid-a',
    profileId: null,
    requester: 'user',
    createdAt: '2026-10-14T12:00:00.000Z',
  });
  await storage.funnelEvents.insert({
    id: 'fe-2',
    event: 'analyze_enqueued',
    sessionRef: 'sid-a',
    profileId: null,
    requester: 'demo',
    createdAt: '2026-10-14T13:00:00.000Z',
  });
  await storage.funnelEvents.insert({
    id: 'fe-3',
    event: 'share_clicked',
    sessionRef: null,
    profileId: P1,
    requester: null,
    createdAt: '2026-10-15T01:00:00.000Z',
  });
}

const SINCE = '2026-10-01T00:00:00.000Z';

describe('funnel summary', () => {
  it('table 为默认格式：按 event 聚合次数/去重会话/NULL 会话', async () => {
    const { storage, deps, out } = await harness();
    await seed(storage);
    const code = await run(['funnel', 'summary', '--since', SINCE], deps);
    expect(code).toBe(0);
    expect(out()).toContain('event\tevents\tdistinctSessions\tnullSessions');
    expect(out()).toContain('analyze_enqueued\t2\t1\t0');
    expect(out()).toContain('share_clicked\t1\t0\t1');
  });

  it('--format json 输出 { summary: [...] }', async () => {
    const { storage, deps, out } = await harness();
    await seed(storage);
    const code = await run(['funnel', 'summary', '--since', SINCE, '--format', 'json'], deps);
    expect(code).toBe(0);
    const body = JSON.parse(out()) as { summary: Array<Record<string, unknown>> };
    expect(body.summary).toHaveLength(2);
    expect(body.summary[0]).toMatchObject({ event: 'analyze_enqueued', events: 2 });
  });

  it('--until 边界不含；空窗口输出提示行', async () => {
    const { storage, deps, out } = await harness();
    await seed(storage);
    const empty = await run(
      ['funnel', 'summary', '--since', SINCE, '--until', '2026-10-14T00:00:00.000Z'],
      deps,
    );
    expect(empty).toBe(0);
    expect(out()).toContain('(no funnel events in window)');
  });
});

describe('funnel daily', () => {
  it('按自然日 × event 聚合（table 默认）', async () => {
    const { storage, deps, out } = await harness();
    await seed(storage);
    const code = await run(['funnel', 'daily', '--since', SINCE], deps);
    expect(code).toBe(0);
    expect(out()).toContain('day\tevent\tevents');
    expect(out()).toContain('2026-10-14\tanalyze_enqueued\t2');
    expect(out()).toContain('2026-10-15\tshare_clicked\t1');
  });

  it('--format json 输出 { daily: [...] }', async () => {
    const { storage, deps, out } = await harness();
    await seed(storage);
    const code = await run(['funnel', 'daily', '--since', SINCE, '--format', 'json'], deps);
    expect(code).toBe(0);
    const body = JSON.parse(out()) as { daily: Array<Record<string, unknown>> };
    expect(body.daily).toHaveLength(2);
    expect(body.daily[0]).toMatchObject({ day: '2026-10-14', event: 'analyze_enqueued' });
  });
});

describe('funnel 参数与分发', () => {
  it('缺 --since → 退出码 2', async () => {
    const { deps, err } = await harness();
    const code = await run(['funnel', 'summary'], deps);
    expect(code).toBe(2);
    expect(err()).toContain('--since');
  });

  it('--format 非法 → 退出码 2', async () => {
    const { deps, err } = await harness();
    const code = await run(['funnel', 'summary', '--since', SINCE, '--format', 'csv'], deps);
    expect(code).toBe(2);
    expect(err()).toContain('--format');
  });

  it('未知子命令 → 退出码 2 并打印用法', async () => {
    const { deps, err } = await harness();
    const code = await run(['funnel', 'explode'], deps);
    expect(code).toBe(2);
    expect(err()).toContain('Usage: jobagent funnel');
  });
});
