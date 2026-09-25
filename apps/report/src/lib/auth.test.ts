import { describe, expect, it } from 'vitest';
import { createStorage, type StorageContext } from '@jobagent/storage';
import { canViewApplications, canViewGatedContent, readCookie, resolveViewer } from './auth';

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

/** 投递管道可见性（决策 #17-F11）：认领即收归本人，未认领画像沿用公开口径。 */
describe('canViewApplications', () => {
  const user = { kind: 'user', platform: 'github', login: 'alice', claimedProfileId: null } as const;
  const otherUser = { kind: 'user', platform: 'github', login: 'mallory', claimedProfileId: null } as const;
  const giteeUser = { kind: 'user', platform: 'gitee', login: 'alice', claimedProfileId: null } as const;
  const anon = { kind: 'anonymous' } as const;
  const unclaimed = { subjectClaimed: false, subjectPlatform: 'github', subjectLogin: 'bob' };
  const claimedByAlice = { subjectClaimed: true, subjectPlatform: 'github', subjectLogin: 'alice' };
  const claimedByOther = { subjectClaimed: true, subjectPlatform: 'github', subjectLogin: 'bob' };
  const fusedClaimed = { subjectClaimed: true, subjectPlatform: 'all', subjectLogin: 'alice' };

  it('leaves an unclaimed profile readable by anyone, matching the API', () => {
    expect(canViewApplications(anon, unclaimed)).toBe(true);
    expect(canViewApplications(user, unclaimed)).toBe(true);
  });

  it('locks a claimed profile to exactly its owner', () => {
    expect(canViewApplications(user, claimedByAlice)).toBe(true);
    expect(canViewApplications(anon, claimedByAlice)).toBe(false);
    expect(canViewApplications(otherUser, claimedByOther)).toBe(false);
    // 同名但不同平台不算本人（与 API 比对 subjectPlatform 的判据一致）
    expect(canViewApplications(giteeUser, claimedByAlice)).toBe(false);
  });

  it('never treats a fused storage row as a matchable owner platform', () => {
    // 融合行 subjectPlatform='all' 对任何登录平台都不等，等价于"无法证明本人"
    expect(canViewApplications(user, fusedClaimed)).toBe(false);
  });
});
