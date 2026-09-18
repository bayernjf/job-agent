import { describe, expect, it } from 'vitest';
import {
  AUTH_ERROR_CODES,
  AUTH_SESSION_COOKIE,
  AUTH_STATE_COOKIE,
  AuthMeSchema,
  ClaimResultSchema,
} from './index.js';

describe('AuthMeSchema', () => {
  it('accepts the anonymous minimal shape', () => {
    expect(AuthMeSchema.safeParse({ kind: 'anonymous' }).success).toBe(true);
  });

  it('accepts the full authenticated user shape', () => {
    const result = AuthMeSchema.safeParse({
      kind: 'user',
      accountId: 'acc-1',
      platform: 'github',
      login: 'torvalds',
      name: 'Linus',
      avatarUrl: 'https://avatars.githubusercontent.com/u/1?v=4',
      claimedProfileId: 'prof-1',
      expiresAt: '2026-09-25T00:00:00.000Z',
    });
    expect(result.success).toBe(true);
  });

  it('allows nullable name/avatar/claimedProfileId', () => {
    const result = AuthMeSchema.safeParse({
      kind: 'user',
      accountId: 'acc-1',
      platform: 'gitee',
      login: 'someone',
      name: null,
      avatarUrl: null,
      claimedProfileId: null,
    });
    expect(result.success).toBe(true);
  });

  it('rejects an unsupported platform', () => {
    expect(
      AuthMeSchema.safeParse({ kind: 'user', accountId: 'a', platform: 'gitlab', login: 'x' })
        .success,
    ).toBe(false);
  });

  it('never carries the email or provider numeric id (PII minimisation)', () => {
    const parsed = AuthMeSchema.safeParse({
      kind: 'user',
      accountId: 'acc-1',
      platform: 'github',
      login: 'x',
      email: 'x@example.com', // 多余键被 Zod 默认剥离
      providerAccountId: '12345',
    });
    expect(parsed.success).toBe(true);
    const data = parsed.data as Record<string, unknown>;
    expect(data).not.toHaveProperty('email');
    expect(data).not.toHaveProperty('providerAccountId');
  });
});

describe('ClaimResultSchema', () => {
  it('accepts a successful claim result', () => {
    const result = ClaimResultSchema.safeParse({
      profileId: 'prof-1',
      claimed: true,
      subject: { platform: 'github', login: 'torvalds' },
      claimedProfileId: 'prof-1',
    });
    expect(result.success).toBe(true);
  });

  it('rejects claimed=false (the endpoint only returns successful claims)', () => {
    expect(
      ClaimResultSchema.safeParse({
        profileId: 'prof-1',
        claimed: false,
        subject: { platform: 'github', login: 'x' },
        claimedProfileId: null,
      }).success,
    ).toBe(false);
  });
});

describe('auth cookie names and error codes', () => {
  it('keeps cookie names stable for the edge middleware', () => {
    expect(AUTH_SESSION_COOKIE).toBe('jobagent_session');
    expect(AUTH_STATE_COOKIE).toBe('jobagent_oauth_state');
  });

  it('keeps stable wire error codes shared with the frontend', () => {
    expect(AUTH_ERROR_CODES).toEqual({
      authRequired: 'AUTH_REQUIRED',
      notConfigured: 'AUTH_NOT_CONFIGURED',
      invalidState: 'AUTH_INVALID_STATE',
      exchangeFailed: 'AUTH_EXCHANGE_FAILED',
      profileNotFound: 'AUTH_PROFILE_NOT_FOUND',
      notProfileOwner: 'AUTH_NOT_PROFILE_OWNER',
    });
  });
});
