/**
 * Principal 解析与演示模式边缘工具（design-demo-mode-20260915 §7.1、§12）。
 * 薄 I/O + 纯解析：坏/过期 Cookie 静默降级 anonymous，便于单测。
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Context } from 'hono';
import { AUTH_SESSION_COOKIE, type Principal } from '@jobagent/shared';
import type {
  IAccountsRepository,
  IAuthSessionsRepository,
  IDemoSessionsRepository,
} from '@jobagent/storage';

export const DEMO_COOKIE = 'jobagent_demo';

/** 从 Cookie 头解析单个 cookie（document.cookie 风格），不存在返回 undefined。 */
export function readCookie(raw: string | undefined, name: string): string | undefined {
  if (!raw) return undefined;
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const value = part.slice(eq + 1).trim();
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
  return undefined;
}

/**
 * 从 Cookie 解析当前 Principal；坏/过期会话静默降级 anonymous。
 * now 注入以便测试确定性。
 */
export async function resolvePrincipal(
  cookieHeader: string | undefined,
  demoSessions: IDemoSessionsRepository,
  now: () => string,
): Promise<Principal> {
  const token = readCookie(cookieHeader, DEMO_COOKIE);
  if (!token) return { kind: 'anonymous' };
  const session = await demoSessions.getActive(token, now());
  if (!session) return { kind: 'anonymous' };
  return {
    kind: 'demo',
    sessionId: session.id,
    analyzeCount: session.analyzeCount,
    matchCount: session.matchCount,
    expiresAt: session.expiresAt,
  };
}

/**
 * 取可信客户端 IP。仅在 trustProxy 时采信 X-Forwarded-For 首段（防伪造）；
 * 否则回退直连 socket 地址；本地无代理且拿不到时返回 null（即不做 IP 限流）。
 */
export function pickClientIp(
  xForwardedFor: string | undefined,
  trustProxy: boolean,
  remoteAddr?: string | null,
): string | null {
  if (trustProxy && xForwardedFor) {
    const first = xForwardedFor.split(',')[0]?.trim();
    if (first) return first;
  }
  const direct = remoteAddr?.trim();
  return direct ? direct : null;
}

/** 从 Hono 上下文取客户端 IP（封装 node-server 的 socket 地址读取）。 */
export function clientIp(c: Context, trustProxy: boolean): string | null {
  const xff = c.req.header('x-forwarded-for');
  let remote: string | null | undefined;
  // @hono/node-server 下可拿到底层 Node req；其他运行时缺省 undefined
  const incoming = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)
    ?.incoming;
  remote = incoming?.socket?.remoteAddress;
  return pickClientIp(xff, trustProxy, remote);
}

/** salted SHA-256，只存哈希、绝不存明文 IP（§12）。 */
export function hashIp(ip: string, salt: string): string {
  return createHash('sha256').update(`${salt}:${ip}`).digest('hex');
}

/** 不可猜的演示会话 id（同时是 Cookie 值）。 */
export function generateSessionId(): string {
  return `demo-${randomBytes(32).toString('base64url')}`;
}

/** 账号内部稳定 id。 */
export function generateAccountId(): string {
  return `acc-${randomUUID()}`;
}

/** 不可猜的登录会话 token（同时是 jobagent_session Cookie 值）。 */
export function generateAuthSessionToken(): string {
  return `ses-${randomBytes(32).toString('base64url')}`;
}

/**
 * 从 jobagent_session Cookie 解析登录用户 Principal。
 * 无 Cookie / 会话过期或撤销 / 账号缺失均返回 null（调用方据此回退到 demo/匿名解析）。
 */
export async function resolveAuthPrincipal(
  cookieHeader: string | undefined,
  authSessions: IAuthSessionsRepository,
  accounts: IAccountsRepository,
  now: () => string,
): Promise<Principal | null> {
  const token = readCookie(cookieHeader, AUTH_SESSION_COOKIE);
  if (!token) return null;
  const session = await authSessions.getActive(token, now());
  if (!session) return null;
  const account = await accounts.getById(session.accountId);
  if (!account) return null;
  return {
    kind: 'user',
    accountId: account.id,
    sessionId: session.id,
    platform: account.platform,
    login: account.login,
    expiresAt: session.expiresAt,
  };
}
