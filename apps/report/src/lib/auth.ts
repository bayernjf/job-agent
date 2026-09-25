/**
 * 报告页 SSR 访问者身份解析（授权分级闸，2026-09-19）。
 *
 * 报告页是 Astro SSR、直读只读 storage（不走 API），因此在此独立解析登录态：
 * 读 HttpOnly Cookie jobagent_session → auth_sessions 取未撤销/未过期会话 →
 * accounts 取登录名。与 API 的 resolveAuthPrincipal 同哲学：坏/过期 Cookie、
 * 只读查询失败一律静默降级 anonymous，绝不抛错拖垮整页。
 *
 * 注意：只读连接，绝不调用 authSessions.touch()（那是写操作）。
 * demo 身份在报告页不做区分（演示会话仅用于触发新分析的配额闸），分级闸只区分
 * 「已登录 user」与「未登录（anonymous/demo）」两档。
 */
import { AUTH_SESSION_COOKIE, type SupportedPlatform } from '@jobagent/shared';
import type { StorageContext } from '@jobagent/storage';
import { getStorage } from './db';

export type Viewer =
  | { kind: 'anonymous' }
  | {
      kind: 'user';
      platform: SupportedPlatform;
      login: string;
      claimedProfileId: string | null;
    };

/** 从 Cookie 头解析单个 cookie（document.cookie 风格），不存在返回 undefined。 */
export function readCookie(raw: string | undefined | null, name: string): string | undefined {
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

export interface ResolveViewerDeps {
  /** 测试注入 storage；生产走只读单例 */
  storage?: StorageContext;
  /** 测试注入当前时间（ISO），默认 new Date() */
  nowIso?: string;
}

/**
 * 解析报告页访问者身份。任何异常都降级 anonymous（fail-open 的是"登录墙"而非数据：
 * 画像本身来自公开行为，降级只会让访客多看登录墙，不会泄露非公开数据）。
 */
export async function resolveViewer(
  cookieHeader: string | undefined | null,
  deps: ResolveViewerDeps = {},
): Promise<Viewer> {
  const token = readCookie(cookieHeader, AUTH_SESSION_COOKIE);
  if (!token) return { kind: 'anonymous' };
  try {
    const storage = deps.storage ?? (await getStorage());
    const nowIso = deps.nowIso ?? new Date().toISOString();
    const session = await storage.authSessions.getActive(token, nowIso);
    if (!session) return { kind: 'anonymous' };
    const account = await storage.accounts.getById(session.accountId);
    if (!account) return { kind: 'anonymous' };
    return {
      kind: 'user',
      platform: account.platform,
      login: account.login,
      claimedProfileId: account.claimedProfileId,
    };
  } catch {
    return { kind: 'anonymous' };
  }
}

/** 已登录用户（含本人与登录的招聘方）可见完整证据/面试工具；未登录见登录墙。 */
export function canViewGatedContent(viewer: Viewer): boolean {
  return viewer.kind === 'user';
}

/** 投递管道可见性判定需要的画像存储行列 */
export interface ApplicationScopeSubject {
  subjectClaimed: boolean;
  subjectPlatform: string;
  subjectLogin: string;
}

/**
 * 投递追踪区块是否挂载（决策 #17-F11，认领即隐私开关）。
 *
 * 与 API 侧 `requireProfileOwner` **同一判据**：画像未被本人认领时不设限（它没有可
 * 授权的主体，报告本身按决策 #1-A 就是公开的，匿名求职链路因此不受影响）；一旦认领，
 * 只有那个 platform+login 的登录账号看得到。两侧判据不一致就会出现"页面渲染了区块、
 * island 每次请求都吃 401"的破页面，所以这里刻意复用同一组列值而不是看 snapshot。
 *
 * 融合画像（`subjectPlatform === 'all'`）永不等于任何登录账号的平台，也就永远走
 * "未认领"分支——与它当前无法被认领的现状（`ClaimProfile` 隐藏）一致。
 */
export function canViewApplications(
  viewer: Viewer,
  profile: ApplicationScopeSubject,
): boolean {
  if (!profile.subjectClaimed) return true;
  return (
    viewer.kind === 'user' &&
    viewer.platform === profile.subjectPlatform &&
    viewer.login === profile.subjectLogin
  );
}
