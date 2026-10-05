/**
 * 真全栈 E2E 的共享夹具动作（2026-10-05）。
 *
 * 两个 spec（工作台 / 报告页投递追踪）都要"以夹具账号登录真浏览器 + 以同一账号打真 API"，
 * Cookie 与 Authorization 两处若各写一份，改 token 时必然漂移，故收敛在这里。
 */
import type { Page } from '@playwright/test';
import { FIXTURE_RECRUITER_SESSION_TOKEN, FIXTURE_SESSION_TOKEN } from './global-setup';

export const API = 'http://127.0.0.1:3101';

/** 服务端视角（`page.request.*`）带同一会话凭证 */
export const authHeaders = { Cookie: `jobagent_session=${FIXTURE_SESSION_TOKEN}` };
export const recruiterAuthHeaders = {
  Cookie: `jobagent_session=${FIXTURE_RECRUITER_SESSION_TOKEN}`,
};

/** 浏览器视角：种下夹具会话 Cookie（真 OAuth 需要外网，故用固定 token 直连真会话表）。 */
export async function login(page: Page): Promise<void> {
  await loginAs(page, FIXTURE_SESSION_TOKEN);
}

/** 浏览器视角：以已声明招聘方身份种下夹具会话 Cookie。 */
export async function loginAsRecruiter(page: Page): Promise<void> {
  await loginAs(page, FIXTURE_RECRUITER_SESSION_TOKEN);
}

async function loginAs(page: Page, token: string): Promise<void> {
  await page.context().addCookies([
    {
      name: 'jobagent_session',
      value: token,
      domain: '127.0.0.1',
      path: '/',
      httpOnly: true,
      sameSite: 'Lax',
    },
  ]);
}
