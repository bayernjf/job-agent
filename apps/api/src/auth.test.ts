import { describe, expect, it } from 'vitest';
import { AUTH_DEFAULTS, loadAuthConfig } from './auth-config.js';
import { FakeAuthProvider } from './fake-auth.js';
import { generateOAuthState, verifyOAuthState } from './github-auth.js';
import type { OAuthProfile } from './auth-provider.js';

describe('loadAuthConfig', () => {
  it('reports github as not configured when client id/secret are absent', () => {
    const cfg = loadAuthConfig({});
    expect(cfg.github.configured).toBe(false);
    expect(cfg.sessionTtlMs).toBe(AUTH_DEFAULTS.sessionTtlMs);
    expect(cfg.afterLoginRedirectUrl).toBe('/');
  });

  it('reports configured only when both client id and secret are present', () => {
    expect(
      loadAuthConfig({ GITHUB_OAUTH_CLIENT_ID: 'id', GITHUB_OAUTH_CLIENT_SECRET: '' }).github
        .configured,
    ).toBe(false);
    const cfg = loadAuthConfig({
      GITHUB_OAUTH_CLIENT_ID: 'id',
      GITHUB_OAUTH_CLIENT_SECRET: 'secret',
    });
    expect(cfg.github.configured).toBe(true);
    expect(cfg.github.clientId).toBe('id');
  });

  it('falls back to the default TTL on invalid input and trims the callback base trailing slash', () => {
    const cfg = loadAuthConfig({
      AUTH_SESSION_TTL_MS: 'not-a-number',
      AUTH_CALLBACK_BASE_URL: 'https://app.example.com/',
    });
    expect(cfg.sessionTtlMs).toBe(AUTH_DEFAULTS.sessionTtlMs);
    expect(cfg.callbackBaseUrl).toBe('https://app.example.com');
  });

  it('honours an explicit after-login URL and production flag', () => {
    const cfg = loadAuthConfig({
      AUTH_AFTER_LOGIN_URL: 'https://app.example.com/report',
      NODE_ENV: 'production',
    });
    expect(cfg.afterLoginRedirectUrl).toBe('https://app.example.com/report');
    expect(cfg.isProduction).toBe(true);
  });

  it('reports gitee as configured only when both GITEE_OAUTH id and secret are present', () => {
    expect(loadAuthConfig({}).gitee.configured).toBe(false);
    expect(
      loadAuthConfig({ GITEE_OAUTH_CLIENT_ID: 'id', GITEE_OAUTH_CLIENT_SECRET: '' }).gitee
        .configured,
    ).toBe(false);
    const cfg = loadAuthConfig({
      GITEE_OAUTH_CLIENT_ID: 'gid',
      GITEE_OAUTH_CLIENT_SECRET: 'gsecret',
    });
    expect(cfg.gitee.configured).toBe(true);
    expect(cfg.gitee.clientId).toBe('gid');
  });
});

describe('OAuth state signing', () => {
  const secret = 'test-state-secret';

  it('round-trips a generated state and rejects tampered/empty values', () => {
    const state = generateOAuthState(secret);
    expect(verifyOAuthState(state, secret)).toBe(true);
    expect(state).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);

    // 篡改 mac
    const tampered = `${state.slice(0, -1)}${state.endsWith('A') ? 'B' : 'A'}`;
    expect(verifyOAuthState(tampered, secret)).toBe(false);
    // 错误密钥
    expect(verifyOAuthState(state, 'other-secret')).toBe(false);
    // 空/畸形
    expect(verifyOAuthState(undefined, secret)).toBe(false);
    expect(verifyOAuthState('no-dot', secret)).toBe(false);
    expect(verifyOAuthState('', secret)).toBe(false);
  });

  it('generates distinct nonces', () => {
    expect(generateOAuthState(secret)).not.toBe(generateOAuthState(secret));
  });
});

describe('FakeAuthProvider', () => {
  const profile: OAuthProfile = {
    platform: 'github',
    providerAccountId: '101',
    login: 'alice',
    name: 'Alice',
    email: 'alice@example.com',
    avatarUrl: 'https://example.com/a.png',
  };

  it('builds a callback-style authorize url carrying state and code', () => {
    const provider = new FakeAuthProvider(profile);
    const url = provider.authorizeUrl('state-123', 'http://localhost:3000/auth/github/callback');
    const parsed = new URL(url);
    expect(parsed.searchParams.get('state')).toBe('state-123');
    expect(parsed.searchParams.get('code')).toBe('fake-code');
  });

  it('returns the canned profile on exchange', async () => {
    const provider = new FakeAuthProvider(profile);
    await expect(provider.exchangeCodeForProfile('fake-code', 'http://x')).resolves.toEqual(profile);
  });

  it('raises an exchange error when configured to fail', async () => {
    const provider = new FakeAuthProvider(null, 'upstream down');
    await expect(provider.exchangeCodeForProfile('fake-code', 'http://x')).rejects.toThrow(
      'upstream down',
    );
  });
});
