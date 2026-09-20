/**
 * 账号/OAuth 认证配置（账号里程碑，2026-09-18，决策 #1-A/#6-A；Gitee 平台 2026-09-19 对称新增）。
 *
 * 单一事实源：GITHUB_OAUTH_* / GITEE_OAUTH_* / AUTH_* 环境变量只在这里读取一次，非法值
 * 回退默认并 warn，不在各端点散落 process.env。纯函数便于单测。未配置某平台 client
 * id/secret 时该平台 configured=false，对应登录路由返回 501 AUTH_NOT_CONFIGURED（测试用
 * FakeAuthProvider 不依赖它），其余接口（demo / 浏览公开画像）照常工作。会话 TTL、state
 * 密钥、回调基址等两平台共用，仅 client id/secret 按平台分别配置。
 */

/** 单个 OAuth 平台的客户端凭证与配置态（GitHub / Gitee 同构）。 */
export interface OAuthProviderConfig {
  clientId: string;
  clientSecret: string;
  /** 两者齐备才算配置完成，登录路由才可用 */
  configured: boolean;
}

export interface AuthConfig {
  github: OAuthProviderConfig;
  gitee: OAuthProviderConfig;
  /** 登录会话有效期（ms），同时是会话 Cookie Max-Age（默认 30 天） */
  sessionTtlMs: number;
  /**
   * 签署 OAuth state 的 HMAC 密钥；空串=每次进程启动随机（开发可用，生产多实例/
   * 重启会使进行中的登录失效，故生产必须经 AUTH_STATE_SECRET 固定）。
   */
  stateSecret: string;
  /**
   * OAuth 回调基址，如 https://app.jobagent.example；空串=运行时按请求 Origin/Host
   * 推导（本地 http://localhost:3000）。
   */
  callbackBaseUrl: string;
  /**
   * API 在同源下的挂载前缀（不含尾斜杠），如 `/api`（形态 C：报告页同域把 Hono
   * 挂在 /api/* 下）。它只影响**对外可见**的 OAuth redirect_uri 与临时 Cookie
   * Path（Hono 内部路由仍注册在 /auth/*，由平台层剥前缀转发）；根挂载时为空串。
   */
  mountPrefix: string;
  /** 登录成功后跳转的前端地址（报告页/落地页）；默认 '/'（同源首页） */
  afterLoginRedirectUrl: string;
  isProduction: boolean;
}

export const AUTH_DEFAULTS = {
  sessionTtlMs: 30 * 24 * 60 * 60 * 1000, // 30 天
  afterLoginRedirectUrl: '/',
} as const;

function positiveInt(
  raw: string | undefined,
  fallback: number,
  label: string,
  min: number,
): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) {
    console.warn(`[auth-config] invalid ${label}=${JSON.stringify(raw)}, fallback to ${fallback}`);
    return fallback;
  }
  return n;
}

function trimOrEmpty(raw: string | undefined): string {
  return raw?.trim() ?? '';
}

/**
 * 归一化 API 挂载前缀：去空白与尾斜杠、必须以 / 开头、只允许安全路径字符
 * （字母数字/-/_，可多级）。非法值 warn 并回退根挂载（空串），避免拼出畸形
 * redirect_uri 或 Cookie Path。
 */
function normalizeMountPrefix(raw: string | undefined): string {
  const value = trimOrEmpty(raw).replace(/\/+$/, '');
  if (value === '') return '';
  if (!value.startsWith('/') || !/^\/[A-Za-z0-9/_-]+$/.test(value)) {
    console.warn(`[auth-config] invalid API_MOUNT_PREFIX=${JSON.stringify(raw)}, fallback to ''`);
    return '';
  }
  return value;
}

/** 组装单个平台凭证配置；id 与 secret 都非空才 configured。 */
function providerConfig(clientId: string, clientSecret: string): OAuthProviderConfig {
  return { clientId, clientSecret, configured: Boolean(clientId && clientSecret) };
}

/** 从环境变量对象加载认证配置（默认 process.env），纯函数、可测试。 */
export function loadAuthConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const github = providerConfig(
    trimOrEmpty(env.GITHUB_OAUTH_CLIENT_ID),
    trimOrEmpty(env.GITHUB_OAUTH_CLIENT_SECRET),
  );
  const gitee = providerConfig(
    trimOrEmpty(env.GITEE_OAUTH_CLIENT_ID),
    trimOrEmpty(env.GITEE_OAUTH_CLIENT_SECRET),
  );
  return {
    github,
    gitee,
    sessionTtlMs: positiveInt(
      env.AUTH_SESSION_TTL_MS,
      AUTH_DEFAULTS.sessionTtlMs,
      'AUTH_SESSION_TTL_MS',
      60_000,
    ),
    stateSecret: trimOrEmpty(env.AUTH_STATE_SECRET),
    callbackBaseUrl: trimOrEmpty(env.AUTH_CALLBACK_BASE_URL).replace(/\/+$/, ''),
    mountPrefix: normalizeMountPrefix(env.API_MOUNT_PREFIX),
    afterLoginRedirectUrl: trimOrEmpty(env.AUTH_AFTER_LOGIN_URL) || AUTH_DEFAULTS.afterLoginRedirectUrl,
    isProduction: env.NODE_ENV === 'production',
  };
}
