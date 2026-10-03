/**
 * 账号认证路由（Q1 单文件拆分）：GitHub / Gitee OAuth web flow、会话、招聘方声明。
 * 决策 #1-A/#6-A、#4 海内外同步。
 */
import type { Context, Hono } from 'hono';
import { setCookie, deleteCookie } from 'hono/cookie';
import {
  AUTH_ERROR_CODES,
  AUTH_SESSION_COOKIE,
  AUTH_STATE_COOKIE,
  AUTH_RETURN_COOKIE,
  RecruiterDeclareRequestSchema,
  type AuthMe,
} from '@jobagent/shared';
import {
  generateAccountId,
  generateAuthSessionToken,
  readCookie,
} from '../principal.js';
import type { AuthProvider, OAuthProfile } from '../auth-provider.js';
import { OAuthExchangeError } from '../auth-provider.js';
import { generateOAuthState, verifyOAuthState } from '../oauth-state.js';
import { sanitizeReturnTo } from '../auth-return-to.js';
import {
  authReturnCookieOptions,
  authSessionCookieOptions,
  authStateCookieOptions,
  oauthBaseOrigin,
} from './helpers.js';
import type { HonoEnv } from './types.js';
import type { RouteDeps } from './context.js';

export function registerAuth(app: Hono<HonoEnv>, d: RouteDeps): void {
  const { repos, now, authCfg, githubProvider, giteeProvider, stateSecret } = d;

  /**
   * 注册某平台的 login + callback 两条 OAuth 路由（平台无关，GitHub/Gitee 各调一次）。
   * provider 为 null（未配置凭证）时路由仍注册，但 login/callback 都返回 501，
   * 与 GitHub 历史行为一致，便于前端探测与排障。临时 state/return Cookie 的 Path 为
   * `<mountPrefix>/auth`，两个平台的回调都能读到；形态 C（API 挂在 /api）下 mountPrefix='/api'，
   * redirect_uri 也必须用带前缀的对外路径（平台登记的回调与 token 交换都按它严格比对）。
   */
  const registerOAuthFlow = (
    platform: AuthProvider['platform'],
    provider: AuthProvider | null,
    label: string,
  ) => {
    const loginPath = `/auth/${platform}/login`;
    const callbackPath = `/auth/${platform}/callback`;
    // 对外可见的回调路径（Hono 内部路由仍是 callbackPath，由同域挂载层剥掉 /api 前缀转发）
    const publicCallbackPath = `${authCfg.mountPrefix}${callbackPath}`;
    const notConfiguredBody = {
      error: `${label} OAuth is not configured`,
      code: AUTH_ERROR_CODES.notConfigured,
    };

    // login：写签名 state Cookie（+可选 return_to 深链 Cookie）并 302 到平台授权页
    app.get(loginPath, (c: Context) => {
      if (!provider) return c.json(notConfiguredBody, 501);
      const redirectUri = `${oauthBaseOrigin(c, authCfg)}${publicCallbackPath}`;
      const state = generateOAuthState(stateSecret);
      setCookie(c, AUTH_STATE_COOKIE, state, authStateCookieOptions(authCfg));
      // 登录后回跳深链：仅接受同源相对路径（防开放重定向），经本站临时 Cookie 流转，
      // 不进平台 state、不落日志；非法/缺失则回调后回退 AUTH_AFTER_LOGIN_URL。
      const returnTo = sanitizeReturnTo(c.req.query('return_to'));
      if (returnTo) {
        setCookie(c, AUTH_RETURN_COOKIE, returnTo, authReturnCookieOptions(authCfg));
      }
      return c.redirect(provider.authorizeUrl(state, redirectUri), 302);
    });

    // callback：校验 state → 授权码换资料 → upsert 账号 → 建登录会话 → 回跳深链
    app.get(callbackPath, async (c: Context) => {
      if (!provider) return c.json(notConfiguredBody, 501);
      const query = c.req.query();
      const cookieState = readCookie(c.req.header('Cookie'), AUTH_STATE_COOKIE);
      if (
        !query.state ||
        !cookieState ||
        query.state !== cookieState ||
        !verifyOAuthState(query.state, stateSecret)
      ) {
        return c.json(
          { error: 'invalid or missing OAuth state', code: AUTH_ERROR_CODES.invalidState },
          400,
        );
      }
      if (!query.code) {
        return c.json(
          { error: 'missing authorization code', code: AUTH_ERROR_CODES.invalidState },
          400,
        );
      }
      const redirectUri = `${oauthBaseOrigin(c, authCfg)}${publicCallbackPath}`;
      let identity: OAuthProfile;
      try {
        identity = await provider.exchangeCodeForProfile(query.code, redirectUri);
      } catch (err) {
        if (err instanceof OAuthExchangeError) {
          // 任何授权码交换/取资料失败都按上游故障处理（502 Bad Gateway）
          return c.json({ error: err.message, code: AUTH_ERROR_CODES.exchangeFailed }, 502);
        }
        throw err;
      }

      const account = await repos.accounts.upsertFromProvider({
        id: generateAccountId(),
        identity: {
          platform: identity.platform,
          providerAccountId: identity.providerAccountId,
          login: identity.login,
          name: identity.name ?? null,
          email: identity.email ?? null,
          avatarUrl: identity.avatarUrl ?? null,
        },
      });
      // 决策 #21-5：ADMIN_ACCOUNT_LOGINS env 白名单（逗号分隔 login）登录自动置管理员。
      // 每次登录都检查（幂等），管理员资格由平台主 env 控制，不暴露任何自助入口。
      const adminLogins = (process.env.ADMIN_ACCOUNT_LOGINS ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (adminLogins.includes(identity.login)) {
        await repos.accounts.setAdmin(account.id, true);
      }
      const nowIso = now();
      const expiresAt = new Date(Date.parse(nowIso) + authCfg.sessionTtlMs).toISOString();
      const token = generateAuthSessionToken();
      await repos.authSessions.create({ id: token, accountId: account.id, expiresAt });
      setCookie(c, AUTH_SESSION_COOKIE, token, authSessionCookieOptions(authCfg, nowIso));
      deleteCookie(c, AUTH_STATE_COOKIE, { path: `${authCfg.mountPrefix}/auth` });
      // 消费回跳深链：再次校验（Cookie 值不可被客户端信任为已校验），用完即删；
      // 非法/缺失回退默认落地页。
      const returnTo = sanitizeReturnTo(
        readCookie(c.req.header('Cookie'), AUTH_RETURN_COOKIE),
      );
      deleteCookie(c, AUTH_RETURN_COOKIE, { path: `${authCfg.mountPrefix}/auth` });
      return c.redirect(returnTo ?? authCfg.afterLoginRedirectUrl, 302);
    });
  };

  registerOAuthFlow('github', githubProvider, 'GitHub');
  registerOAuthFlow('gitee', giteeProvider, 'Gitee');

  // POST /auth/logout：撤销当前登录会话并清 Cookie（匿名调用为 no-op）
  app.post('/auth/logout', async (c) => {
    const principal = c.get('principal');
    if (principal.kind === 'user') {
      await repos.authSessions.revoke(principal.sessionId);
    }
    deleteCookie(c, AUTH_SESSION_COOKIE, { path: '/' });
    return c.json({ ok: true });
  });

  // GET /auth/me：当前登录身份（刻意不含 email/providerAccountId）
  app.get('/auth/me', async (c) => {
    const principal = c.get('principal');
    if (principal.kind !== 'user') {
      return c.json({
        kind: principal.kind === 'demo' ? 'demo' : 'anonymous',
      } satisfies AuthMe);
    }
    const account = await repos.accounts.getById(principal.accountId);
    return c.json({
      kind: 'user',
      accountId: principal.accountId,
      platform: principal.platform,
      login: principal.login,
      name: account?.name ?? null,
      avatarUrl: account?.avatarUrl ?? null,
      claimedProfileId: account?.claimedProfileId ?? null,
      recruiterDeclaredAt: account?.recruiterDeclaredAt ?? null,
      // LLM 供给（决策 #21）：admin 面权限位（迁移 023 is_admin）
      canManageLlmCatalog: account?.isAdmin ?? false,
      expiresAt: principal.expiresAt,
    } satisfies AuthMe);
  });

  // GET /auth/providers：各平台 OAuth 是否已配置（公开只读，只回布尔态，供前端渲染登录入口）
  app.get('/auth/providers', (c) => {
    return c.json({
      github: { configured: githubProvider !== null },
      gitee: { configured: giteeProvider !== null },
    });
  });

  // PUT /auth/recruiter：招聘方显式自声明（F10，#17 第一期）。幂等：已声明保留原时刻。
  // 仅登录可用（401）；无审核/无门槛；必须是显式动作，不能由访问 /recruit 推导（§7.3）。
  app.put('/auth/recruiter', async (c) => {
    const principal = c.get('principal');
    if (principal.kind !== 'user') {
      return c.json(
        { error: 'authentication required', code: AUTH_ERROR_CODES.authRequired },
        401,
      );
    }
    // 空对象负载仍走 Zod（.strict() 拒绝额外字段）；body 可缺省。
    const parsed = RecruiterDeclareRequestSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json({ error: 'invalid body', details: parsed.error.flatten() }, 400);
    }
    const nowIso = now();
    const updated = await repos.accounts.declareRecruiter(principal.accountId, nowIso);
    if (!updated) return c.json({ error: 'account not found' }, 404);
    return c.json(
      {
        kind: 'user',
        accountId: principal.accountId,
        platform: principal.platform,
        login: principal.login,
        name: updated.name,
        avatarUrl: updated.avatarUrl,
        claimedProfileId: updated.claimedProfileId,
        recruiterDeclaredAt: updated.recruiterDeclaredAt,
        expiresAt: principal.expiresAt,
      } satisfies AuthMe,
      200,
    );
  });

  // DELETE /auth/recruiter：撤销招聘方声明（反制通道，§2.1/§6.2）。幂等；既有
  // 面试/投递数据不删除（created_by_account_id 保留），只收回招聘方面访问权。
  app.delete('/auth/recruiter', async (c) => {
    const principal = c.get('principal');
    if (principal.kind !== 'user') {
      return c.json(
        { error: 'authentication required', code: AUTH_ERROR_CODES.authRequired },
        401,
      );
    }
    const updated = await repos.accounts.revokeRecruiter(principal.accountId);
    if (!updated) return c.json({ error: 'account not found' }, 404);
    return new Response(null, { status: 204 });
  });
}
