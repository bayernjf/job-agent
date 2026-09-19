import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { runMigrations } from './sqlite/migrator.js';
import { openSqlite } from './sqlite/connection.js';
import { SqliteAccountsRepository } from './sqlite/accounts-repo.js';
import { SqliteAuthSessionsRepository } from './sqlite/auth-sessions-repo.js';
import { SqliteProfilesRepository } from './sqlite/profiles-repo.js';
import type { ProviderIdentity } from './entities/index.js';

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../db/migrations/sqlite',
);

const NOW = '2026-09-18T12:00:00.000Z';
const FUTURE = '2026-12-31T00:00:00.000Z';
const PAST = '2026-01-01T00:00:00.000Z';

function githubIdentity(login: string, providerAccountId: string): ProviderIdentity {
  return {
    platform: 'github',
    providerAccountId,
    login,
    name: `Name ${login}`,
    email: `${login}@example.com`,
    avatarUrl: `https://avatars.githubusercontent.com/u/${providerAccountId}`,
  };
}

function fresh() {
  const { client, db } = openSqlite(':memory:');
  runMigrations(client, MIGRATIONS_DIR);
  return {
    client,
    accounts: new SqliteAccountsRepository(db),
    authSessions: new SqliteAuthSessionsRepository(db),
    profiles: new SqliteProfilesRepository(db),
    close: () => client.close(),
  };
}

/** 直接插一行最小 profiles 记录（snapshot 与本测试无关，markClaimed 只更新 claimed 列）。 */
function insertMinimalProfile(client: Database.Database, id: string, login: string): void {
  client
    .prepare(
      `INSERT INTO profiles (
        id, analyzer_version, subject_platform, subject_login, subject_claimed,
        data_window_since, data_window_until, analysis_layers, status, snapshot
      ) VALUES (?, ?, 'github', ?, 0, ?, ?, '["L0","L1"]', 'complete', '{}')`,
    )
    .run(id, 'analyzer-1', login, PAST, NOW);
}

function claimedValue(client: Database.Database, id: string): number {
  const row = client.prepare('SELECT subject_claimed AS c FROM profiles WHERE id = ?').get(id) as {
    c: number;
  };
  return row.c;
}

describe('SqliteAccountsRepository', () => {
  it('inserts a new account from a provider identity and reads it back', async () => {
    const { accounts, close } = fresh();
    const stored = await accounts.upsertFromProvider({
      id: 'acc-1',
      identity: githubIdentity('alice', '101'),
    });
    expect(stored.id).toBe('acc-1');
    expect(stored.platform).toBe('github');
    expect(stored.login).toBe('alice');
    expect(stored.claimedProfileId).toBeNull();

    const byId = await accounts.getById('acc-1');
    expect(byId?.email).toBe('alice@example.com');
    const byProvider = await accounts.getByProvider('github', '101');
    expect(byProvider?.id).toBe('acc-1');
    close();
  });

  it('upserts by (platform, providerAccountId): refreshes profile without creating a second row', async () => {
    const { accounts, close } = fresh();
    await accounts.upsertFromProvider({ id: 'acc-1', identity: githubIdentity('alice', '101') });
    // 同一平台身份再次登录，登录名/展示名变更，且不应新建行
    const updated = await accounts.upsertFromProvider({
      id: 'acc-ignored-new-id',
      identity: { ...githubIdentity('alice-renamed', '101'), name: 'Alice Renamed' },
    });
    expect(updated.id).toBe('acc-1');
    expect(updated.login).toBe('alice-renamed');
    expect(updated.name).toBe('Alice Renamed');

    const sameLoginDifferentId = await accounts.getByProvider('github', '101');
    expect(sameLoginDifferentId?.id).toBe('acc-1');
    expect(await accounts.getById('acc-ignored-new-id')).toBeUndefined();
    close();
  });

  it('treats the same numeric id on different platforms as distinct accounts', async () => {
    const { accounts, close } = fresh();
    await accounts.upsertFromProvider({
      id: 'acc-gh',
      identity: githubIdentity('bob', '202'),
    });
    await accounts.upsertFromProvider({
      id: 'acc-ge',
      identity: { ...githubIdentity('bob', '202'), platform: 'gitee' },
    });
    expect((await accounts.getByProvider('github', '202'))?.id).toBe('acc-gh');
    expect((await accounts.getByProvider('gitee', '202'))?.id).toBe('acc-ge');
    close();
  });

  it('records the claimed profile id, and returns undefined for an unknown account', async () => {
    const { accounts, close } = fresh();
    await accounts.upsertFromProvider({ id: 'acc-1', identity: githubIdentity('alice', '101') });
    const claimed = await accounts.setClaimedProfile('acc-1', 'prof-7');
    expect(claimed?.claimedProfileId).toBe('prof-7');
    expect(await accounts.setClaimedProfile('missing', 'prof-x')).toBeUndefined();
    close();
  });
});

describe('SqliteAuthSessionsRepository', () => {
  it('creates a session and resolves it while active and unexpired', async () => {
    const { authSessions, close } = fresh();
    await authSessions.create({ id: 'ses-1', accountId: 'acc-1', expiresAt: FUTURE });
    const active = await authSessions.getActive('ses-1', NOW);
    expect(active?.accountId).toBe('acc-1');
    expect(active?.status).toBe('active');
    close();
  });

  it('does not resolve an expired or revoked session', async () => {
    const { authSessions, close } = fresh();
    await authSessions.create({ id: 'ses-exp', accountId: 'acc-1', expiresAt: PAST });
    expect(await authSessions.getActive('ses-exp', NOW)).toBeUndefined();

    await authSessions.create({ id: 'ses-rev', accountId: 'acc-1', expiresAt: FUTURE });
    await authSessions.revoke('ses-rev');
    expect(await authSessions.getActive('ses-rev', NOW)).toBeUndefined();
    close();
  });

  it('returns undefined for an unknown session token', async () => {
    const { authSessions, close } = fresh();
    expect(await authSessions.getActive('nope', NOW)).toBeUndefined();
    close();
  });

  it('touches last_seen_at on use', async () => {
    const { authSessions, close } = fresh();
    await authSessions.create({ id: 'ses-1', accountId: 'acc-1', expiresAt: FUTURE });
    await authSessions.touch('ses-1', '2026-09-18T13:00:00.000Z');
    const active = await authSessions.getActive('ses-1', NOW);
    expect(active?.lastSeenAt).toBe('2026-09-18T13:00:00.000Z');
    close();
  });
});

describe('SqliteAuthSessionsRepository.purgeExpired', () => {
  function insertSession(
    client: Database.Database,
    id: string,
    accountId: string,
    expiresAt: string,
    status: 'active' | 'revoked',
    lastSeenAt: string,
  ): void {
    client
      .prepare(
        `INSERT INTO auth_sessions (id, account_id, expires_at, status, created_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, accountId, expiresAt, status, PAST, lastSeenAt);
  }

  it('deletes expired and stale-revoked sessions but keeps active and recently revoked ones', async () => {
    const ctx = fresh();
    insertSession(ctx.client, 'ses-expired', 'acc-1', PAST, 'active', PAST);
    insertSession(ctx.client, 'ses-revoked-old', 'acc-1', FUTURE, 'revoked', PAST);
    insertSession(ctx.client, 'ses-live', 'acc-1', FUTURE, 'active', NOW);
    // 已撤销但最后使用在保留窗内（晚于截止），保留
    insertSession(ctx.client, 'ses-revoked-recent', 'acc-1', FUTURE, 'revoked', FUTURE);

    const removed = await ctx.authSessions.purgeExpired(NOW, 0);
    expect(removed).toBe(2);
    expect(await ctx.authSessions.getActive('ses-live', NOW)).toBeDefined();
    // 最近撤销的行虽不 active，但仍应物理保留
    const recentRow = ctx.client
      .prepare('SELECT id FROM auth_sessions WHERE id = ?')
      .get('ses-revoked-recent') as { id: string } | undefined;
    expect(recentRow?.id).toBe('ses-revoked-recent');
    expect(
      (ctx.client.prepare('SELECT id FROM auth_sessions WHERE id = ?').get('ses-expired') as
        | { id: string }
        | undefined),
    ).toBeUndefined();
    ctx.close();
  });
});

describe('SqliteAccountsRepository.deleteUnclaimed', () => {
  function insertAccount(
    client: Database.Database,
    id: string,
    claimedProfileId: string | null,
    updatedAt: string,
  ): void {
    client
      .prepare(
        `INSERT INTO accounts (id, platform, provider_account_id, login, name, email, avatar_url, claimed_profile_id, created_at, updated_at)
         VALUES (?, 'github', ?, ?, null, null, null, ?, ?, ?)`,
      )
      .run(id, `${id}-pid`, id, claimedProfileId, PAST, updatedAt);
  }

  it('deletes only stale unclaimed accounts without a live session', async () => {
    const ctx = fresh();
    insertAccount(ctx.client, 'acc-old-unclaimed', null, PAST);
    insertAccount(ctx.client, 'acc-claimed', 'prof-1', PAST);
    insertAccount(ctx.client, 'acc-live-session', null, PAST);
    insertAccount(ctx.client, 'acc-recent', null, FUTURE);
    // acc-live-session 持有一条未过期会话，不应被删
    ctx.client
      .prepare(
        `INSERT INTO auth_sessions (id, account_id, expires_at, status, created_at, last_seen_at)
         VALUES ('ses-live', 'acc-live-session', ?, 'active', ?, ?)`,
      )
      .run(FUTURE, PAST, NOW);

    const removed = await ctx.accounts.deleteUnclaimed(NOW, 0);
    expect(removed).toBe(1);
    expect(await ctx.accounts.getById('acc-old-unclaimed')).toBeUndefined();
    expect(await ctx.accounts.getById('acc-claimed')).toBeDefined();
    expect(await ctx.accounts.getById('acc-live-session')).toBeDefined();
    expect(await ctx.accounts.getById('acc-recent')).toBeDefined();
    ctx.close();
  });
});

describe('SqliteProfilesRepository.markClaimed', () => {
  it('flips subject_claimed to true (idempotent) and leaves unknown ids as a no-op', async () => {
    const ctx = fresh();
    insertMinimalProfile(ctx.client, 'prof-1', 'alice');
    expect(claimedValue(ctx.client, 'prof-1')).toBe(0);

    await ctx.profiles.markClaimed('prof-1');
    expect(claimedValue(ctx.client, 'prof-1')).toBe(1);

    await ctx.profiles.markClaimed('prof-1'); // 幂等，不报错
    expect(claimedValue(ctx.client, 'prof-1')).toBe(1);

    await ctx.profiles.markClaimed('does-not-exist'); // 静默无操作
    ctx.close();
  });
});
