import { describe, expect, it } from 'vitest';
import { createStorage, type StorageContext } from '@jobagent/storage';
import { canViewGatedContent, readCookie, resolveViewer } from './auth';

/**
 * 报告页 SSR 访问者解析（授权分级闸）：内存 SQLite，不打网络。
 * 坏/过期/缺失会话一律降级 anonymous，绝不抛错。
 */
async function setupStorage(): Promise<StorageContext> {
  const storage = await createStorage({ sqlitePath: ':memory:' });
  const account = await storage.accounts.upsertFromProvider({
    id: 'acc-1',
    identity: {
      platform: 'github',
      providerAccountId: '101',
      login: 'alice',
      name: 'Alice',
      email: null,
      avatarUrl: null,
    },
  });
  const future = new Date(Date.now() + 3600_000).toISOString();
  const past = new Date(Date.now() - 3600_000).toISOString();
  await storage.authSessions.create({ id: 'ses-active', accountId: account.id, expiresAt: future });
  await storage.authSessions.create({ id: 'ses-expired', accountId: account.id, expiresAt: past });
  return storage;
}

describe('readCookie', () => {
  it('parses a named cookie and decodes URI components', () => {
    expect(readCookie('a=1; jobagent_session=ses-active; b=2', 'jobagent_session')).toBe(
      'ses-active',
    );
    expect(readCookie(undefined, 'x')).toBeUndefined();
    expect(readCookie('a=1', 'x')).toBeUndefined();
  });
});

describe('resolveViewer', () => {
  it('returns anonymous without a session cookie', async () => {
    const storage = await setupStorage();
    expect(await resolveViewer(undefined, { storage })).toEqual({ kind: 'anonymous' });
    expect(await resolveViewer('', { storage })).toEqual({ kind: 'anonymous' });
    expect(await resolveViewer('other=1', { storage })).toEqual({ kind: 'anonymous' });
  });

  it('resolves a logged-in user from an active session', async () => {
    const storage = await setupStorage();
    const viewer = await resolveViewer('jobagent_session=ses-active', { storage });
    expect(viewer).toMatchObject({ kind: 'user', platform: 'github', login: 'alice' });
  });

  it('falls back to anonymous for an expired or unknown session', async () => {
    const storage = await setupStorage();
    expect(await resolveViewer('jobagent_session=ses-expired', { storage })).toEqual({
      kind: 'anonymous',
    });
    expect(await resolveViewer('jobagent_session=ses-missing', { storage })).toEqual({
      kind: 'anonymous',
    });
  });

  it('gates content only for logged-in users', async () => {
    const storage = await setupStorage();
    const user = await resolveViewer('jobagent_session=ses-active', { storage });
    const anon = await resolveViewer(undefined, { storage });
    expect(canViewGatedContent(user)).toBe(true);
    expect(canViewGatedContent(anon)).toBe(false);
  });
});
