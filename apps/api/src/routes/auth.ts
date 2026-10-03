/**
 * 账号认证路由（Q1 单文件拆分）：GitHub / Gitee OAuth web flow、会话、招聘方声明。
 * 决策 #1-A/#6-A、#4 海内外同步。
 */
import type { Context, Hono } from 'hono';
import { setCookie, deleteCookie } from 'hono/cookie';
import {
  API_TOKEN_TTL_MS,
  AUTH_ERROR_CODES,
  AUTH_SESSION_COOKIE,
  AUTH_STATE_COOKIE,
  AUTH_RETURN_COOKIE,
  EXT_AUTH_CODE_TTL_MS,
  EXT_AUTH_ERROR_CODES,
  ExtensionAuthTokenConsumeRequestSchema,
  RecruiterDeclareRequestSchema,
  type ApiTokenSummary,
  type AuthMe,
  type ExtensionAuthCodeIssueResponse,
  type ExtensionAuthTokenConsumeResponse,
} from '@jobagent/shared';
import {
  generateAccountId,
  generateApiToken,
  generateAuthSessionToken,
  generateExtensionAuthCode,
  readCookie,
  sha256Hex,
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


  // ── 扩展登录态（决策 #22，design-扩展登录态-20261004.md）─────────────────
  // 扩展经「工作台签发一次性授权码 → 兑换长期 API Token（Bearer）」获得登录身份；
  // 服务端只存 SHA-256 哈希，明文仅签发响应返回一次。登录始终发生在工作台，
  // 扩展不重做 OAuth；code 5 分钟单次消费，token 90 天滑动续期、可撤销。

  // POST /auth/extension-token/issue：为当前登录账号签发一次性授权码。
  // 仅限 cookie 登录的 user（扩展要拿身份必须先在工作台登录）；响应只含 code+expiresAt，
  // code 经 externally_connectable + S7 origin 校验的通道传给扩展（本端点不接收 code）。
  app.post('/auth/extension-token/issue', async (c) => {
    const principal = c.get('principal');
    if (principal.kind !== 'user') {
      return c.json({ error: 'authentication required', code: AUTH_ERROR_CODES.authRequired }, 401);
    }
    const code = generateExtensionAuthCode();
    const expiresAt = new Date(Date.parse(now()) + EXT_AUTH_CODE_TTL_MS).toISOString();
    await repos.extensionAuthCodes.create({ id: code, accountId: principal.accountId, expiresAt });
    const body: ExtensionAuthCodeIssueResponse = { code, expiresAt };
    return c.json(body, 200);
  });

  // POST /auth/extension-token/consume：扩展用一次性 code 兑换长期 api_token。
  // code 即凭证（无额外鉴权）；单次消费防重放；库中只存 token 的 SHA-256 哈希。
  app.post('/auth/extension-token/consume', async (c) => {
    const parsed = ExtensionAuthTokenConsumeRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: 'invalid request', code: EXT_AUTH_ERROR_CODES.codeNotFound }, 400);
    }
    const { code } = parsed.data;
    const existing = await repos.extensionAuthCodes.getById(code);
    if (!existing) {
      return c.json({ error: 'extension auth code not found', code: EXT_AUTH_ERROR_CODES.codeNotFound }, 404);
    }
    if (existing.usedAt !== null) {
      return c.json({ error: 'extension auth code already used', code: EXT_AUTH_ERROR_CODES.codeUsed }, 410);
    }
    if (existing.expiresAt <= now()) {
      return c.json({ error: 'extension auth code expired', code: EXT_AUTH_ERROR_CODES.codeExpired }, 410);
    }
    const consumed = await repos.extensionAuthCodes.consume(code, now());
    if (!consumed) {
      // 并发双请求只有一个成功：另一个按已消费处理
      return c.json({ error: 'extension auth code already used', code: EXT_AUTH_ERROR_CODES.codeUsed }, 410);
    }
    const account = await repos.accounts.getById(existing.accountId);
    if (!account) {
      return c.json({ error: 'issuing account not found', code: EXT_AUTH_ERROR_CODES.codeNotFound }, 404);
    }
    const apiToken = generateApiToken();
    const expiresAt = new Date(Date.parse(now()) + API_TOKEN_TTL_MS).toISOString();
    await repos.apiTokens.create({
      id: apiToken,
      accountId: existing.accountId,
      tokenHash: sha256Hex(apiToken),
      name: 'browser extension',
      expiresAt,
    });
    const body: ExtensionAuthTokenConsumeResponse = {
      apiToken,
      name: 'browser extension',
      expiresAt,
      account: { platform: account.platform, login: account.login },
    };
    return c.json(body, 200);
  });

  // GET /auth/extension-tokens：授权管理列表（仅指纹尾 4 位，不可逆查明文）。
  app.get('/auth/extension-tokens', async (c) => {
    const principal = c.get('principal');
    if (principal.kind !== 'user') {
      return c.json({ error: 'authentication required', code: AUTH_ERROR_CODES.authRequired }, 401);
    }
    const tokens = await repos.apiTokens.listActiveByAccount(principal.accountId, now());
    const summaries: ApiTokenSummary[] = tokens.map((t) => ({
      id: t.id,
      fingerprint: t.id.slice(-4),
      name: t.name,
      createdAt: t.createdAt,
      lastSeenAt: t.lastSeenAt,
      expiresAt: t.expiresAt,
    }));
    return c.json({ tokens: summaries }, 200);
  });

  // DELETE /auth/extension-tokens/:id：撤销本人扩展 token（不可逆；不存在/非本人 404）。
  app.delete('/auth/extension-tokens/:id', async (c) => {
    const principal = c.get('principal');
    if (principal.kind !== 'user') {
      return c.json({ error: 'authentication required', code: AUTH_ERROR_CODES.authRequired }, 401);
    }
    const tokenId = c.req.param('id');
    const owned = await repos.apiTokens.listActiveByAccount(principal.accountId, now());
    if (!owned.some((t) => t.id === tokenId)) {
      return c.json({ error: 'extension token not found', code: EXT_AUTH_ERROR_CODES.tokenNotFound }, 404);
    }
    await repos.apiTokens.revoke(tokenId, now());
    return new Response(null, { status: 204 });
  });
}
