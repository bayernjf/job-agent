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

/** 管理员白名单来源；account-ids 为不可变身份，legacy-logins 仅迁移期兼容。 */
export type AdminAllowlistSource = 'account-ids' | 'legacy-logins' | 'disabled';

export interface AdminAllowlist {
  /** `platform:providerAccountId`；非空时优先，legacyLogins 被忽略 */
  accountIds: string[];
  /** 旧口径 login；可被平台改名/释放，仅在 accountIds 为空时生效 */
  legacyLogins: string[];
  source: AdminAllowlistSource;
}

export interface AuthConfig {
  github: OAuthProviderConfig;
  gitee: OAuthProviderConfig;
  /** 管理员白名单（ADMIN_ACCOUNT_IDS 优先，ADMIN_ACCOUNT_LOGINS 兼容期兜底） */
  admin: AdminAllowlist;
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

const ADMIN_PLATFORMS = new Set(['github', 'gitee']);

function splitCsv(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 解析 ADMIN_ACCOUNT_IDS（`platform:providerAccountId`，逗号分隔）。
 * 不可变身份白名单：平台改名不影响命中，也就不会被旧 login 的再注册者接管。
 * 非法条目不回显原值（避免把疑似账号标识写进日志），只报序号与格式要求。
 */
function parseAdminAccountIds(raw: string | undefined): string[] {
  const out: string[] = [];
  splitCsv(raw).forEach((entry, index) => {
    const sep = entry.indexOf(':');
    const platform = sep > 0 ? entry.slice(0, sep).trim().toLowerCase() : '';
    const providerAccountId = sep > 0 ? entry.slice(sep + 1).trim() : '';
    if (!ADMIN_PLATFORMS.has(platform) || providerAccountId === '') {
      console.warn(
        `[auth-config] invalid ADMIN_ACCOUNT_IDS entry #${index + 1} (expect platform:providerAccountId)`,
      );
      return;
    }
    out.push(`${platform}:${providerAccountId}`);
  });
  return out;
}

/**
 * 管理员白名单优先级：
 * 1) ADMIN_ACCOUNT_IDS 非空 → 只用不可变身份；ADMIN_ACCOUNT_LOGINS 明确忽略并 warn。
 * 2) 仅 ADMIN_ACCOUNT_LOGINS → 迁移期兼容（login 可被改名/释放，存在接管风险）。
 * 3) 都为空 → disabled，登录时会把历史 is_admin 降权。
 */
export function loadAdminAllowlist(env: NodeJS.ProcessEnv = process.env): AdminAllowlist {
  const accountIds = parseAdminAccountIds(env.ADMIN_ACCOUNT_IDS);
  const legacyLogins = splitCsv(env.ADMIN_ACCOUNT_LOGINS);
  if (accountIds.length > 0) {
    if (legacyLogins.length > 0) {
      console.warn(
        '[auth-config] ADMIN_ACCOUNT_LOGINS ignored because ADMIN_ACCOUNT_IDS is set; migrate legacy logins to platform:providerAccountId',
      );
    }
    return { accountIds, legacyLogins: [], source: 'account-ids' };
  }
  if (legacyLogins.length > 0) {
    return { accountIds: [], legacyLogins, source: 'legacy-logins' };
  }
  return { accountIds: [], legacyLogins: [], source: 'disabled' };
}

/** 判定一次登录身份是否命中管理员白名单（account-ids 口径不看可变 login）。 */
export function isAdminIdentity(
  allowlist: AdminAllowlist,
  identity: { platform: string; providerAccountId: string; login: string },
): boolean {
  if (allowlist.source === 'account-ids') {
    return allowlist.accountIds.includes(`${identity.platform}:${identity.providerAccountId}`);
  }
  if (allowlist.source === 'legacy-logins') {
    return allowlist.legacyLogins.includes(identity.login);
  }
  return false;
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
    admin: loadAdminAllowlist(env),
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
