/**
 * GitHub OAuth web application flow（账号里程碑，2026-09-18，决策 #1-A）。
 * 文档：https://docs.github.com/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps
 *
 * 仅用 Node24 全局 fetch，不引第三方 OAuth 依赖。凭证（client secret）只在服务端使用。
 * state 用 HMAC-SHA256 签名（nonce.mac），配合回调时比对 state Cookie 防 CSRF。
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { SupportedPlatform } from '@jobagent/shared';
import { OAuthExchangeError, type AuthProvider, type OAuthProfile } from './auth-provider.js';

const AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
const TOKEN_URL = 'https://github.com/login/oauth/access_token';
const USER_URL = 'https://api.github.com/user';
/** 公开资料无需 scope；user:email 仅为尽力取邮箱（邮箱可空，不阻塞登录）。 */
const SCOPE = 'user:email';

export class GithubAuthProvider implements AuthProvider {
  readonly platform: SupportedPlatform = 'github';

  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
  ) {}

  authorizeUrl(state: string, redirectUri: string): string {
    const query = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: redirectUri,
      state,
      scope: SCOPE,
      allow_signup: 'true',
    });
    return `${AUTHORIZE_URL}?${query.toString()}`;
  }

  async exchangeCodeForProfile(code: string, redirectUri: string): Promise<OAuthProfile> {
    const token = await this.exchangeCode(code, redirectUri);
    return this.fetchProfile(token);
  }

  private async exchangeCode(code: string, redirectUri: string): Promise<string> {
    let res: Response;
    try {
      res = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/x-www-form-urlencoded',
          'user-agent': 'jobagent',
        },
        body: new URLSearchParams({
          client_id: this.clientId,
          client_secret: this.clientSecret,
          code,
          redirect_uri: redirectUri,
        }),
      });
    } catch (err) {
      throw new OAuthExchangeError(`token request failed: ${(err as Error).message}`);
    }
    if (!res.ok) throw new OAuthExchangeError(`token endpoint returned ${res.status}`);
    const payload = (await res.json()) as { access_token?: string; error?: string };
    if (!payload.access_token) {
      throw new OAuthExchangeError(`no access token: ${payload.error ?? 'unknown error'}`);
    }
    return payload.access_token;
  }

  private async fetchProfile(token: string): Promise<OAuthProfile> {
    let res: Response;
    try {
      res = await fetch(USER_URL, {
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${token}`,
          'user-agent': 'jobagent',
        },
      });
    } catch (err) {
      throw new OAuthExchangeError(`user request failed: ${(err as Error).message}`);
    }
    if (!res.ok) throw new OAuthExchangeError(`user endpoint returned ${res.status}`);
    const user = (await res.json()) as {
      id?: number;
      login?: string;
      name?: string | null;
      email?: string | null;
      avatar_url?: string | null;
    };
    if (typeof user.id !== 'number' || !user.login) {
      throw new OAuthExchangeError('malformed user payload from GitHub');
    }
    return {
      platform: 'github',
      providerAccountId: String(user.id),
      login: user.login,
      name: user.name ?? null,
      email: user.email ?? null,
      avatarUrl: user.avatar_url ?? null,
    };
  }
}

/** 生成签名 state：`nonce.mac`，nonce 随机、mac 为 HMAC-SHA256(base64url)。 */
export function generateOAuthState(secret: string): string {
  const nonce = randomBytes(16).toString('base64url');
  return `${nonce}.${stateMac(secret, nonce)}`;
}

/** 校验 state 签名（常量时间比较）；格式错误或签名不符返回 false。 */
export function verifyOAuthState(state: string | undefined | null, secret: string): boolean {
  if (!state) return false;
  const dot = state.lastIndexOf('.');
  if (dot <= 0) return false;
  const nonce = state.slice(0, dot);
  const mac = state.slice(dot + 1);
  const expected = stateMac(secret, nonce);
  const actualBuf = Buffer.from(mac);
  const expectedBuf = Buffer.from(expected);
  if (actualBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(actualBuf, expectedBuf);
}

function stateMac(secret: string, nonce: string): string {
  return createHmac('sha256', secret).update(nonce).digest('base64url');
}
