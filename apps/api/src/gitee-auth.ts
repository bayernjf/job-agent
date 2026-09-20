/**
 * Gitee OAuth2 授权码流程（Gitee 平台登录，2026-09-19，决策 #4 海内外同步）。
 * 官方文档：https://gitee.com/api/v5/oauth_doc （用户接口 /api/v5/user）。
 *
 * 与 GitHub web flow 同构、实现同一 AuthProvider 端口，三处协议差异：
 *  1. 授权页必须显式带 response_type=code；
 *  2. 换 token 的表单必须显式带 grant_type=authorization_code；
 *  3. 取用户按 Gitee v5 惯例把 access_token 放在 query 参数（?access_token=）。
 *
 * 仅用 Node24 全局 fetch，不引第三方 OAuth 依赖。client secret 只在服务端使用；
 * scope 仅申请最小的 user_info。state 的生成/校验在路由层（oauth-state.ts），本类不涉及。
 */
import type { SupportedPlatform } from '@jobagent/shared';
import { OAuthExchangeError, type AuthProvider, type OAuthProfile } from './auth-provider.js';

const AUTHORIZE_URL = 'https://gitee.com/oauth/authorize';
const TOKEN_URL = 'https://gitee.com/oauth/token';
const USER_URL = 'https://gitee.com/api/v5/user';
/** 最小权限：读取当前登录用户的基本资料（登录名/展示名/头像/公开邮箱）。 */
const SCOPE = 'user_info';

export class GiteeAuthProvider implements AuthProvider {
  readonly platform: SupportedPlatform = 'gitee';

  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
  ) {}

  authorizeUrl(state: string, redirectUri: string): string {
    const query = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      state,
      scope: SCOPE,
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
          grant_type: 'authorization_code',
          code,
          client_id: this.clientId,
          client_secret: this.clientSecret,
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
    const url = `${USER_URL}?${new URLSearchParams({ access_token: token }).toString()}`;
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { accept: 'application/json', 'user-agent': 'jobagent' },
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
      throw new OAuthExchangeError('malformed user payload from Gitee');
    }
    return {
      platform: 'gitee',
      providerAccountId: String(user.id),
      login: user.login,
      name: user.name ?? null,
      email: user.email ?? null,
      avatarUrl: user.avatar_url ?? null,
    };
  }
}
