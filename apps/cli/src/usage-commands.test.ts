/**
 * `jobagent usage summary|daily` 子命令测试（决策 #25 ④ 成本回采 Wave D 读侧运营面）。
 * 内存 SQLite 直插 usage_events，零网络：覆盖 table 默认 / json 格式、
 * --account / --category 过滤、空窗口、参数错误退出码与未知子命令。
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
    now: () => '2026-10-14T00:00:00.000Z',
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

async function seed(storage: StorageContext): Promise<void> {
  await storage.usageEvents.insert({
    id: 'usg-b1',
    accountId: 'acct-bob',
    category: 'llm',
    feature: 'cover_letter',
    billingSource: 'builtin',
    provider: 'agnes',
    model: 'agnes-3.0-flash',
    promptTokens: 100,
    completionTokens: 50,
    quantity: null,
    createdAt: '2026-10-10T12:00:00.000Z',
  });
  await storage.usageEvents.insert({
    id: 'usg-o1',
    accountId: 'acct-other',
    category: 'search',
    feature: 'websearch',
    billingSource: 'platform',
    provider: 'tavily',
    model: null,
    promptTokens: null,
    completionTokens: null,
    quantity: 3,
    createdAt: '2026-10-11T00:00:00.000Z',
  });
}

const SINCE = '2026-10-01T00:00:00.000Z';

describe('usage summary', () => {
  it('table 为默认格式：全平台聚合（省略 --account）', async () => {
    const { storage, deps, out } = await harness();
    await seed(storage);
    const code = await run(['usage', 'summary', '--since', SINCE], deps);
    expect(code).toBe(0);
    expect(out()).toContain('category\tfeature\tbillingSource\tevents');
    expect(out()).toContain('llm\tcover_letter\tbuiltin\t1\t100\t50\t0');
    expect(out()).toContain('search\twebsearch\tplatform\t1\t0\t0\t3');
  });

  it('--format json 输出 { summary: [...] }', async () => {
    const { storage, deps, out } = await harness();
    await seed(storage);
    const code = await run(['usage', 'summary', '--since', SINCE, '--format', 'json'], deps);
    expect(code).toBe(0);
    const body = JSON.parse(out()) as { summary: Array<Record<string, unknown>> };
    expect(body.summary).toHaveLength(2);
    expect(body.summary[0]).toMatchObject({ category: 'llm', feature: 'cover_letter' });
  });

  it('--account 过滤只看该账号；--category 过滤只看该大类', async () => {
    const { storage, deps, out } = await harness();
    await seed(storage);
    const byAccount = await run(
      ['usage', 'summary', '--since', SINCE, '--account', 'acct-other', '--format', 'json'],
      deps,
    );
    expect(byAccount).toBe(0);
    const accountBody = JSON.parse(out()) as { summary: Array<Record<string, unknown>> };
    expect(accountBody.summary).toHaveLength(1);
    expect(accountBody.summary[0]).toMatchObject({ category: 'search', feature: 'websearch' });
  });

  it('--category llm 过滤只剩 llm 行', async () => {
    const { storage, deps, out } = await harness();
    await seed(storage);
    const code = await run(
      ['usage', 'summary', '--since', SINCE, '--category', 'llm', '--format', 'json'],
      deps,
    );
    expect(code).toBe(0);
    const body = JSON.parse(out()) as { summary: Array<Record<string, unknown>> };
    expect(body.summary).toHaveLength(1);
    expect(body.summary[0]).toMatchObject({ category: 'llm', sumPromptTokens: 100 });
  });

  it('空窗口输出提示行', async () => {
    const { storage, deps, out } = await harness();
    await seed(storage);
    const code = await run(['usage', 'summary', '--since', '2026-10-13T00:00:00.000Z'], deps);
    expect(code).toBe(0);
    expect(out()).toContain('(no usage events in window)');
  });
});

describe('usage daily', () => {
  it('按自然日 + category 聚合（table 默认）', async () => {
    const { storage, deps, out } = await harness();
    await seed(storage);
    const code = await run(['usage', 'daily', '--since', SINCE], deps);
    expect(code).toBe(0);
    expect(out()).toContain('day\tcategory\tevents');
    expect(out()).toContain('2026-10-10\tllm\t1\t100\t50\t0');
    expect(out()).toContain('2026-10-11\tsearch\t1\t0\t0\t3');
  });

  it('--format json 输出 { daily: [...] }', async () => {
    const { storage, deps, out } = await harness();
    await seed(storage);
    const code = await run(['usage', 'daily', '--since', SINCE, '--format', 'json'], deps);
    expect(code).toBe(0);
    const body = JSON.parse(out()) as { daily: Array<Record<string, unknown>> };
    expect(body.daily).toHaveLength(2);
    expect(body.daily[0]).toMatchObject({ day: '2026-10-10', category: 'llm' });
  });
});

describe('usage 参数与分发', () => {
  it('缺 --since → 退出码 2', async () => {
    const { deps, err } = await harness();
    const code = await run(['usage', 'summary'], deps);
    expect(code).toBe(2);
    expect(err()).toContain('--since');
  });

  it('--category 非法 → 退出码 2', async () => {
    const { deps, err } = await harness();
    const code = await run(['usage', 'summary', '--since', SINCE, '--category', 'bogus'], deps);
    expect(code).toBe(2);
    expect(err()).toContain('invalid usage query');
  });

  it('--format 非法 → 退出码 2', async () => {
    const { deps, err } = await harness();
    const code = await run(['usage', 'summary', '--since', SINCE, '--format', 'csv'], deps);
    expect(code).toBe(2);
    expect(err()).toContain('--format');
  });

  it('未知子命令 → 退出码 2 并打印用法', async () => {
    const { deps, err } = await harness();
    const code = await run(['usage', 'explode'], deps);
    expect(code).toBe(2);
    expect(err()).toContain('Usage: jobagent usage');
  });
});
