/**
 * 测试用 AuthProvider：不打网络，返回预置身份或固定失败。
 * 集成测试（createApp + 内存 SQLite）用它走完整登录/认领链路，确定性、可重复。
 * platform 可注入（默认 github），Gitee 登录链路传 'gitee' 即可复用同一套测试。
 */
import type { SupportedPlatform } from '@jobagent/shared';
import { OAuthExchangeError, type AuthProvider, type OAuthProfile } from './auth-provider.js';

export class FakeAuthProvider implements AuthProvider {
  readonly platform: SupportedPlatform;

  /**
   * @param profile 交换成功时返回的身份；null 表示未配置可用身份
   * @param failure 非空时任何交换都抛此错误（模拟上游失败）
   * @param platform 模拟的登录平台，默认 github
   */
  constructor(
    private readonly profile: OAuthProfile | null,
    private readonly failure?: string,
    platform: SupportedPlatform = 'github',
  ) {
    this.platform = platform;
  }

  authorizeUrl(state: string, redirectUri: string): string {
    const url = new URL(redirectUri);
    url.searchParams.set('state', state);
    url.searchParams.set('code', 'fake-code');
    return url.toString();
  }

  async exchangeCodeForProfile(_code: string, _redirectUri: string): Promise<OAuthProfile> {
    if (this.failure) throw new OAuthExchangeError(this.failure);
    if (!this.profile) throw new OAuthExchangeError('fake provider is not configured');
    return this.profile;
  }
}
