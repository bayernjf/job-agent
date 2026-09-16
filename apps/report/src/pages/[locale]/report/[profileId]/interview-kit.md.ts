/**
 * 面试准备包 Markdown 下载端点（痛点解决方案批次 1）。
 * 路由：/[locale]/report/[profileId]/interview-kit.md
 * SSR 读取画像快照 + 证据明细，输出可下载的 text/markdown。
 */
import type { APIRoute } from 'astro';
import { loadProfile, loadEvidence } from '../../../../lib/db';
import { isLocale, type Locale } from '../../../../i18n/index.js';
import { renderInterviewKit } from '../../../../lib/interview-kit';

export const GET: APIRoute = async ({ params }) => {
  const rawLocale = params.locale;
  if (!isLocale(rawLocale)) {
    return new Response('Not found', { status: 404 });
  }
  const locale: Locale = rawLocale;
  const profileId = params.profileId;
  if (!profileId) return new Response('Not found', { status: 404 });

  const profile = await loadProfile(profileId);
  if (!profile) return new Response('Not found', { status: 404 });

  const evidence = await loadEvidence(profileId);
  const markdown = renderInterviewKit(profile, evidence, locale);

  const safeLogin = profile.subject.login.replace(/[^a-zA-Z0-9._-]/g, '-');
  const filename = `interview-kit-${safeLogin}.md`;

  return new Response(markdown, {
    status: 200,
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  });
};
