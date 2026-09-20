/**
 * GiteeAuthProvider 单测（2026-09-19）：mock 全局 fetch，不打真实网络。
 * 覆盖与 GitHub 的三处协议差异：authorize 必带 response_type=code、token 表单带
 * grant_type=authorization_code、取用户用 ?access_token= query；以及错误映射。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GiteeAuthProvider } from './gitee-auth.js';
import { OAuthExchangeError } from './auth-provider.js';

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

interface FetchCall {
  url: string;
  init?: RequestInit;
}

/** 安装按 URL 分流的 fetch mock，返回记录的调用与可替换的响应工厂。 */
function mockFetch(handlers: {
  token?: Response | (() => Response);
  user?: Response | (() => Response);
}) {
  const calls: FetchCall[] = [];
  const fn = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, init });
    if (u.includes('/oauth/token')) {
      return typeof handlers.token === 'function' ? handlers.token() : handlers.token;
    }
    if (u.includes('/api/v5/user')) {
      return typeof handlers.user === 'function' ? handlers.user() : handlers.user;
    }
    throw new Error(`unexpected fetch to ${u}`);
  });
  vi.stubGlobal('fetch', fn);
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GiteeAuthProvider.authorizeUrl', () => {
  it('builds the gitee authorize URL with response_type=code and scope=user_info', () => {
    const provider = new GiteeAuthProvider('cid', 'secret');
    const url = new URL(
      provider.authorizeUrl('st-1', 'http://localhost:3000/auth/gitee/callback'),
    );
    expect(url.origin + url.pathname).toBe('https://gitee.com/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe('cid');
    expect(url.searchParams.get('redirect_uri')).toBe(
      'http://localhost:3000/auth/gitee/callback',
    );
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('state')).toBe('st-1');
    expect(url.searchParams.get('scope')).toBe('user_info');
  });

  it('declares platform gitee', () => {
    expect(new GiteeAuthProvider('c', 's').platform).toBe('gitee');
  });
});

describe('GiteeAuthProvider.exchangeCodeForProfile', () => {
  it('posts grant_type=authorization_code then reads the user via ?access_token= and maps fields', async () => {
    const calls = mockFetch({
      token: jsonResponse({
        access_token: 'gitee-token',
        token_type: 'bearer',
        expires_in: 86400,
        refresh_token: 'r',
        scope: 'user_info',
      }),
      user: jsonResponse({
        id: 55,
        login: 'bob',
        name: 'Bob',
        email: null,
        avatar_url: 'https://gitee.com/b.png',
      }),
    });
    const provider = new GiteeAuthProvider('cid', 'secret');

    const profile = await provider.exchangeCodeForProfile(
      'the-code',
      'http://localhost:3000/auth/gitee/callback',
    );

    expect(profile).toEqual({
      platform: 'gitee',
      providerAccountId: '55',
      login: 'bob',
      name: 'Bob',
      email: null,
      avatarUrl: 'https://gitee.com/b.png',
    });

    // token 请求：POST 表单含 grant_type / code / client_id / client_secret / redirect_uri
    const tokenCall = calls.find((c) => c.url.includes('/oauth/token'))!;
    expect(tokenCall.init?.method).toBe('POST');
    const tokenBody = String(tokenCall.init?.body);
    const tokenParams = new URLSearchParams(tokenBody);
    expect(tokenParams.get('grant_type')).toBe('authorization_code');
    expect(tokenParams.get('code')).toBe('the-code');
    expect(tokenParams.get('client_id')).toBe('cid');
    expect(tokenParams.get('client_secret')).toBe('secret');
    expect(tokenParams.get('redirect_uri')).toBe(
      'http://localhost:3000/auth/gitee/callback',
    );

    // user 请求：access_token 在 query（Gitee v5 惯例），URL 正确
    const userCall = calls.find((c) => c.url.includes('/api/v5/user'))!;
    expect(userCall.url).toBe('https://gitee.com/api/v5/user?access_token=gitee-token');
  });

  it('throws OAuthExchangeError when the token endpoint is not 2xx', async () => {
    mockFetch({ token: jsonResponse({ error: 'bad_code' }, 400) });
    await expect(
      new GiteeAuthProvider('c', 's').exchangeCodeForProfile('code', 'http://x/cb'),
    ).rejects.toBeInstanceOf(OAuthExchangeError);
  });

  it('throws OAuthExchangeError when no access_token is returned', async () => {
    mockFetch({ token: jsonResponse({ error: 'invalid_grant' }) });
    await expect(
      new GiteeAuthProvider('c', 's').exchangeCodeForProfile('code', 'http://x/cb'),
    ).rejects.toBeInstanceOf(OAuthExchangeError);
  });

  it('throws OAuthExchangeError when the user endpoint is not 2xx', async () => {
    mockFetch({
      token: jsonResponse({ access_token: 't' }),
      user: jsonResponse({ message: 'unauthorized' }, 401),
    });
    await expect(
      new GiteeAuthProvider('c', 's').exchangeCodeForProfile('code', 'http://x/cb'),
    ).rejects.toBeInstanceOf(OAuthExchangeError);
  });

  it('throws OAuthExchangeError on malformed user payload', async () => {
    mockFetch({
      token: jsonResponse({ access_token: 't' }),
      user: jsonResponse({ login: 'no-id' }),
    });
    await expect(
      new GiteeAuthProvider('c', 's').exchangeCodeForProfile('code', 'http://x/cb'),
    ).rejects.toBeInstanceOf(OAuthExchangeError);
  });

  it('wraps a network failure as OAuthExchangeError', async () => {
    const fn = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    vi.stubGlobal('fetch', fn);
    await expect(
      new GiteeAuthProvider('c', 's').exchangeCodeForProfile('code', 'http://x/cb'),
    ).rejects.toBeInstanceOf(OAuthExchangeError);
  });
});
