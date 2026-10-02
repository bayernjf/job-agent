/**
 * API 响应格式化 / Cookie 属性 / 访问闸（从原 index.ts 抽出，Q1 单文件拆分）。
 */
import type { Context } from 'hono';
import {
  AUTH_ERROR_CODES,
  type AbilityProfile,
  type DemoMe,
  type Principal,
} from '@jobagent/shared';
import type {
  StoredAnalysisJob,
  StoredApplication,
  StoredProfile,
} from '@jobagent/storage';
import type { DemoConfig } from '../demo-config.js';
import type { AuthConfig } from '../auth-config.js';

export function formatJob(job: StoredAnalysisJob) {
  return {
    id: job.id,
    subject: {
      platform: job.subjectPlatform,
      login: job.subjectLogin,
    },
    // 只回身份类，绝不回 demoSessionId（它等同会话凭证，见设计 §7.4）
    requester: { kind: job.requesterKind },
    status: job.status,
    stage: job.stage,
    attempts: job.attempts,
    profileId: job.profileId,
    error: job.errorMessage,
    budgetUsed: job.budgetUsed,
    missing: job.missing,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
  };
}

/** 把 Principal 序列化为 GET /demo/me 响应体（demo 带配额状态）。 */
export function toDemoMe(principal: Principal, analyzeQuota: number): DemoMe {
  if (principal.kind !== 'demo') return { kind: 'anonymous' };
  return {
    kind: 'demo',
    sessionId: principal.sessionId,
    expiresAt: principal.expiresAt,
    analyzeQuota,
    analyzeUsed: principal.analyzeCount,
    analyzeRemaining: Math.max(0, analyzeQuota - principal.analyzeCount),
  };
}

/** 演示 Cookie 统一属性（设计 §7.6）；生产 HTTPS 才加 Secure。 */
export function demoCookieOptions(cfg: DemoConfig, nowIso: string) {
  return {
    httpOnly: true,
    sameSite: 'Lax' as const,
    path: '/',
    secure: cfg.isProduction,
    maxAge: Math.floor(cfg.sessionTtlMs / 1000),
    expires: new Date(Date.parse(nowIso) + cfg.sessionTtlMs),
  };
}

/** 登录会话 Cookie（jobagent_session）统一属性；生产 HTTPS 才加 Secure。 */
export function authSessionCookieOptions(cfg: AuthConfig, nowIso: string) {
  return {
    httpOnly: true,
    sameSite: 'Lax' as const,
    path: '/',
    secure: cfg.isProduction,
    maxAge: Math.floor(cfg.sessionTtlMs / 1000),
    expires: new Date(Date.parse(nowIso) + cfg.sessionTtlMs),
  };
}

/** 临时 OAuth state Cookie：仅回调路径可读、10 分钟有效。 */
export function authStateCookieOptions(cfg: AuthConfig) {
  return {
    httpOnly: true,
    sameSite: 'Lax' as const,
    // 形态 C 对外路径带挂载前缀（/api/auth/*）；根挂载时 mountPrefix 为空串
    path: `${cfg.mountPrefix}/auth`,
    secure: cfg.isProduction,
    maxAge: 600,
  };
}

/** 临时 return_to 回跳 Cookie：仅回调路径可读、10 分钟有效（与 state 同生命周期）。 */
export function authReturnCookieOptions(cfg: AuthConfig) {
  return {
    httpOnly: true,
    sameSite: 'Lax' as const,
    path: `${cfg.mountPrefix}/auth`,
    secure: cfg.isProduction,
    maxAge: 600,
  };
}

/** OAuth 回调基址：优先 AUTH_CALLBACK_BASE_URL，否则按当前请求 Origin/Host 推导。 */
export function oauthBaseOrigin(c: Context, cfg: AuthConfig): string {
  if (cfg.callbackBaseUrl) return cfg.callbackBaseUrl;
  const url = new URL(c.req.url);
  return `${url.protocol}//${url.host}`;
}

/**
 * 投递管道的隐私闸（#17-F11，handoff item60 T03）：**认领即隐私开关**。
 *
 * 画像未被本人认领时不设限——它没有可授权的主体，且报告本身按决策 #1-A 就是公开的；
 * 一旦认领，投递列表与写入只对该 platform+login 的登录账号开放。复用既有两码，
 * 不新增错误码族：未登录 401 `AUTH_REQUIRED`、登错人 403 `AUTH_NOT_PROFILE_OWNER`。
 * 返回 undefined 表示放行。
 */
export function requireProfileOwner(c: Context, profile: StoredProfile): Response | undefined {
  if (!profile.subjectClaimed) return undefined;
  const principal = c.get('principal');
  if (principal.kind !== 'user') {
    return c.json({ error: 'authentication required', code: AUTH_ERROR_CODES.authRequired }, 401);
  }
  if (principal.platform !== profile.subjectPlatform || principal.login !== profile.subjectLogin) {
    return c.json({ error: 'not the profile owner', code: AUTH_ERROR_CODES.notProfileOwner }, 403);
  }
  return undefined;
}

/**
 * F10 招聘方面访问闸（决策 #17 第一期，design-recruiter-roles §4/§5）。
 * 两态分流（不静默降级）：
 *   - anonymous / demo → 401 AUTH_REQUIRED（先登录）
 *   - 已登录但未声明     → 403 RECRUITER_DECLARATION_REQUIRED
 *   - 已登录且已声明     → 放行，返回 { principal, account }（同一次 getById，
 *                         与 GET /auth/me 共用一次查询，不在路由内二次查库）
 * 声明是账号属性（accounts.recruiter_declared_at）而非会话/Principal 属性。
 */
export async function requireRecruiter(
  c: Parameters<typeof requireProfileOwner>[0],
  accounts: { getById(id: string): Promise<{ recruiterDeclaredAt: string | null } | undefined> },
): Promise<
  | { principal: Extract<Principal, { kind: 'user' }>; account: { recruiterDeclaredAt: string | null } }
  | Response
> {
  const principal = c.get('principal');
  if (principal.kind !== 'user') {
    return c.json({ error: 'authentication required', code: AUTH_ERROR_CODES.authRequired }, 401);
  }
  const account = await accounts.getById(principal.accountId);
  if (!account || !account.recruiterDeclaredAt) {
    return c.json(
      { error: 'recruiter declaration required', code: AUTH_ERROR_CODES.recruiterRequired },
      403,
    );
  }
  return { principal, account };
}

/**
 * 投递记录的对外投影：剥掉 `createdByAccountId`，只用在**列表**响应上。
 *
 * 归属列只用于服务端校验，不该成为对外可关联的标识——与"accounts.email 只留服务端、
 * 绝不随对外响应出去"同一口径。列表是真正的泄露面：未认领画像的列表会把别人写的行
 * 一起返回，带上它们的账号 id。单行响应（POST/PATCH）按归属校验后必然要么是调用者
 * 自己写的、要么是无主行，因此不外泄第三方标识。
 */
export function publicApplication(application: StoredApplication) {
  const { createdByAccountId: _ownerOnly, ...rest } = application;
  return rest;
}

export function formatProfile(profile: StoredProfile) {
  return {
    id: profile.id,
    analyzerVersion: profile.analyzerVersion,
    subject: {
      platform: profile.subjectPlatform,
      login: profile.subjectLogin,
      claimed: profile.subjectClaimed,
    },
    dataWindow: {
      since: profile.dataWindowSince,
      until: profile.dataWindowUntil,
    },
    analysisLayers: profile.analysisLayers,
    status: profile.status,
    snapshot: profile.snapshot as AbilityProfile | null,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
  };
}

/**
 * Expand an unknown error into a loggable shape, including the driver `code`
 * and the full `cause` chain. Serverless runtimes (Vercel) otherwise surface
 * only an empty 500 with no stack, which makes production failures impossible
 * to diagnose. Stacks are truncated to keep log lines bounded.
 */
export function describeError(err: unknown, depth = 0): unknown {
  if (!(err instanceof Error)) return { value: String(err) };
  const e = err as Error & { code?: string; cause?: unknown };
  const out: Record<string, unknown> = { name: e.name, message: e.message };
  if (e.code) out.code = e.code;
  if (e.stack) out.stack = e.stack.split('\n').slice(0, 14).join('\n');
  if (e.cause && depth < 4) out.cause = describeError(e.cause, depth + 1);
  return out;
}
