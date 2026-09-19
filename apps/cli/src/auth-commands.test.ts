import { describe, expect, it } from 'vitest';
import { createStorage, type StorageContext } from '@jobagent/storage';
import { run, type CliDeps } from './index.js';

// 固定在未来：账号/session 的真实 created/updated 时间（约 2026-09）早于该值，
// 使 retain=0 的截止判定确定性可复现。
const NOW = '2027-06-01T12:00:00.000Z';

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
    now: () => NOW,
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

async function addAccount(
  storage: StorageContext,
  id: string,
  providerAccountId: string,
  login: string,
): Promise<void> {
  await storage.accounts.upsertFromProvider({
    id,
    identity: { platform: 'github', providerAccountId, login, name: login, email: null, avatarUrl: null },
  });
}

describe('jobagent auth cleanup', () => {
  it('purges expired sessions and stale unclaimed accounts, keeping live/claimed ones', async () => {
    const { storage, deps, out } = await harness();

    // 三个账号：stale 未认领无会话（应删）；claimed 已认领（保留）；live 未认领但有未过期会话（保留）
    await addAccount(storage, 'acc-stale', '1001', 'stale-user');
    await addAccount(storage, 'acc-claimed', '1002', 'claimed-user');
    await storage.accounts.setClaimedProfile('acc-claimed', 'prof-claimed');
    await addAccount(storage, 'acc-live', '1003', 'live-user');

    // 一条已过期会话（2026，应清），一条未过期会话（2028，保留并护住 acc-live）
    await storage.authSessions.create({
      id: 'ses-expired',
      accountId: 'acc-stale',
      expiresAt: '2026-01-01T00:00:00.000Z',
    });
    await storage.authSessions.create({
      id: 'ses-live',
      accountId: 'acc-live',
      expiresAt: '2028-01-01T00:00:00.000Z',
    });

    const code = await run(['auth', 'cleanup', '--retain-hours', '0', '--account-retain-hours', '0'], deps);
    expect(code).toBe(0);
    expect(out()).toMatch(/purged 1 .*session\(s\)/);
    expect(out()).toMatch(/and 1 unclaimed account\(s\)/);

    expect(await storage.accounts.getById('acc-stale')).toBeUndefined();
    expect(await storage.accounts.getById('acc-claimed')).toBeDefined();
    expect(await storage.accounts.getById('acc-live')).toBeDefined();
    expect(await storage.authSessions.getActive('ses-expired', NOW)).toBeUndefined();
    expect(await storage.authSessions.getActive('ses-live', NOW)).toBeDefined();
  });

  it('keeps a recently updated unclaimed account within the account retain window', async () => {
    const { storage, deps, out } = await harness();
    await addAccount(storage, 'acc-fresh', '2001', 'fresh-user');
    // 账号保留窗 30 天：账号 updatedAt 距 NOW 不足 30 天的判定依赖真实时钟，
    // 这里用超大保留窗（1000 天）确保近期账号不被删。
    const code = await run(
      ['auth', 'cleanup', '--retain-hours', '0', '--account-retain-hours', String(1000 * 24)],
      deps,
    );
    expect(code).toBe(0);
    expect(out()).toMatch(/and 0 unclaimed account\(s\)/);
    expect(await storage.accounts.getById('acc-fresh')).toBeDefined();
  });

  it('exits 2 for a negative retain-hours', async () => {
    const { deps, err } = await harness();
    const code = await run(['auth', 'cleanup', '--retain-hours=-1'], deps);
    expect(code).toBe(2);
    expect(err()).toContain('non-negative');
  });

  it('exits 2 for a negative account-retain-hours', async () => {
    const { deps, err } = await harness();
    const code = await run(['auth', 'cleanup', '--account-retain-hours=-5'], deps);
    expect(code).toBe(2);
    expect(err()).toContain('non-negative');
  });
});

describe('jobagent auth dispatch', () => {
  it('exits 2 for an unknown auth subcommand', async () => {
    const { deps, err } = await harness();
    const code = await run(['auth', 'bogus'], deps);
    expect(code).toBe(2);
    expect(err()).toContain('Usage: jobagent auth');
  });
});
