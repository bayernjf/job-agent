/**
 * OAuth 身份提供方端口（账号里程碑，2026-09-18）。
 *
 * API 只依赖此接口：GitHub web application flow 是首个实现（github-auth.ts），
 * 测试用 FakeAuthProvider（fake-auth.ts，不打网络）；未来 Gitee OAuth 以同接口新增，
 * 端点/会话/认领逻辑不改。对应内核"证据源无关、端口可替换"的一贯分层。
 */
import type { SupportedPlatform } from '@jobagent/shared';

/** 授权码交换后得到的平台身份资料（用于 accounts upsert） */
export interface OAuthProfile {
  platform: SupportedPlatform;
  /** 平台侧数字用户 id（按字符串存储与比较） */
  providerAccountId: string;
  /** 平台登录名（认领画像时与 profiles.subject_login 比对） */
  login: string;
  name?: string | null;
  /** 尽力获取的邮箱，可空；服务端留存，不随对外身份响应外发 */
  email?: string | null;
  avatarUrl?: string | null;
}

export interface AuthProvider {
  readonly platform: SupportedPlatform;
  /** 构造浏览器跳转的平台授权页 URL；state 由调用方生成并写入临时 Cookie */
  authorizeUrl(state: string, redirectUri: string): string;
  /** 用授权码换 access token，再取用户资料；任何上游失败抛 OAuthExchangeError */
  exchangeCodeForProfile(code: string, redirectUri: string): Promise<OAuthProfile>;
}

/** 授权码交换/取资料失败（上游非 2xx、响应畸形、被拒），端点映射为 502。 */
export class OAuthExchangeError extends Error {
  constructor(
    message: string,
    readonly status = 502,
  ) {
    super(message);
    this.name = 'OAuthExchangeError';
  }
}
