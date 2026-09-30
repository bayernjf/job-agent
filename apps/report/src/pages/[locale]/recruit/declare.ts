/**
 * F10 招聘方声明显式 POST（纯 SSR、无 JS，design-recruiter-roles §6.4/§7.3）：
 *
 * HTML 表单不支持 PUT，声明墙 POST 到本端点。报告页架构是「SSR 直读/直写
 * storage，不走 API」（见 lib/auth.ts、lib/db.ts），故这里不调 Hono createApp()
 * （那会触发 API 的生产启动闸且在 standalone 下另开连接、另找迁移目录），而是
 * 与会话解析同一哲学：读 HttpOnly cookie → auth_sessions 取有效会话 →
 * accounts.declareRecruiter。
 *
 * 成功后 PRG 302 回 /[locale]/recruit（此时渲染人才库）；未登录/未勾选/失败
 * 一律回到声明页并带 ?declare_error=1（不区分原因，避免探测账号状态）。
 * 声明是显式动作（必须勾选 + 提交），访问 /recruit 本身绝不自动打标（§7.3）。
 */
import type { APIRoute } from 'astro';
import { AUTH_SESSION_COOKIE } from '@jobagent/shared';
import { isLocale } from '../../../i18n/index.js';
import { getWritableStorage } from '../../../lib/db.js';
import { readCookie } from '../../../lib/auth.js';

export const POST: APIRoute = async ({ request, params }) => {
  const locale = isLocale(params.locale) ? params.locale : 'en';
  const pagePath = `/${locale}/recruit`;
  const fail = () => Response.redirect(new URL(`${pagePath}?declare_error=1`, request.url), 302);

  let formConsent = '';
  try {
    const form = await request.formData();
    formConsent = String(form.get('consent') ?? '');
  } catch {
    return fail();
  }
  if (formConsent !== '1') return fail();

  try {
    const token = readCookie(request.headers.get('cookie'), AUTH_SESSION_COOKIE);
    if (!token) return fail();
    const storage = await getWritableStorage();
    const nowIso = new Date().toISOString();
    const session = await storage.authSessions.getActive(token, nowIso);
    if (!session) return fail();
    const updated = await storage.accounts.declareRecruiter(session.accountId, nowIso);
    if (!updated) return fail();
    return Response.redirect(new URL(pagePath, request.url), 302);
  } catch {
    return fail();
  }
};
