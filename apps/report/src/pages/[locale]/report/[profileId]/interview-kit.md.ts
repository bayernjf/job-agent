/**
 * 面试准备包 Markdown 下载端点（痛点解决方案批次 1）。
 * 路由：/[locale]/report/[profileId]/interview-kit.md
 * SSR 读取画像快照 + 证据明细，输出可下载的 text/markdown。
 */
import type { APIRoute } from 'astro';
import { loadProfile, loadEvidence, getStorage } from '../../../../lib/db';
import { resolveViewer } from '../../../../lib/auth';
import { createTranslator, isLocale, type Locale } from '../../../../i18n/index.js';
import { browserApiBase } from '../../../../lib/api-base';
import { renderInterviewKit } from '../../../../lib/interview-kit';
import { matchJobs } from '@jobagent/job-source';

/**
 * T16：从 `?jobId=` 加载岗位并做画像技能匹配，供面试准备单"岗位定向"渲染。
 * 任何失败（无 jobId / 岗位不存在 / 匹配为空）都返回 undefined → 降级为通用版，不 500。
 */
async function loadKitOptions(
  profileId: string,
  jobId?: string,
): Promise<Parameters<typeof renderInterviewKit>[3]> {
  if (!jobId) return undefined;
  try {
    const profile = await loadProfile(profileId);
    if (!profile) return undefined;
    const storage = await getStorage();
    const posting = await storage.jobPostings.getById(jobId);
    if (!posting) return undefined;
    const skills = profile.skillTags.map((t) => t.name);
    if (skills.length === 0) return undefined;
    const match = matchJobs([posting], { skills })[0];
    if (!match || match.matchedSkills.length === 0) return undefined;
    return {
      posting: { title: posting.title, company: posting.company, sourceUrl: posting.sourceUrl },
      matchedSkills: match.matchedSkills,
    };
  } catch {
    return undefined;
  }
}

/**
 * 匿名访问下载链接时返回可读的 HTML 401，而不是一行纯文本：
 * 说明为什么需要登录，并给出登录入口。文案不区分画像是否被认领，
 * 且闸门排在 loadProfile 之前，避免泄露画像状态。
 */
function signInRequiredPage(locale: Locale, profileId: string): string {
  const t = createTranslator(locale);
  const segment = encodeURIComponent(profileId);
  const returnTo = `/${locale}/report/${segment}/interview-kit.md`;
  const loginHref = `${browserApiBase()}/auth/github/login?return_to=${encodeURIComponent(returnTo)}`;
  const reportHref = `/${locale}/report/${segment}`;
  return `<!doctype html>
<html lang="${locale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${t('report.kit.signInTitle')}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
         font: 16px/1.6 ui-sans-serif, system-ui, sans-serif; background: #f7f7f5; color: #1c1c1a; }
  main { max-width: 32rem; padding: 2rem; }
  h1 { font-size: 1.35rem; margin: 0 0 .75rem; }
  p { margin: 0 0 1.25rem; opacity: .8; }
  a.primary { display: inline-block; padding: .65rem 1rem; border-radius: .5rem;
              background: #1c1c1a; color: #fff; text-decoration: none; font-weight: 600; }
  a.secondary { margin-left: .75rem; color: inherit; }
  @media (prefers-color-scheme: dark) {
    body { background: #111110; color: #f2f2ef; }
    a.primary { background: #f2f2ef; color: #111110; }
  }
</style>
</head>
<body>
<main>
  <h1>${t('report.kit.signInTitle')}</h1>
  <p>${t('report.kit.signInBody')}</p>
  <a class="primary" href="${loginHref}">${t('report.kit.signInAction')}</a>
  <a class="secondary" href="${reportHref}">${t('report.kit.backToReport')}</a>
</main>
</body>
</html>`;
}

export const GET: APIRoute = async ({ params, request }) => {
  const rawLocale = params.locale;
  if (!isLocale(rawLocale)) {
    return new Response('Not found', { status: 404 });
  }
  const locale: Locale = rawLocale;
  const profileId = params.profileId;
  if (!profileId) return new Response('Not found', { status: 404 });

  // 授权分级闸：面试准备包含完整证据外链，仅登录 user 可下载（与报告页面试题墙一致）。
  // 排在 loadProfile 之前，避免向匿名访问者泄露画像是否存在/是否被认领。
  const viewer = await resolveViewer(request.headers.get('cookie'));
  if (viewer.kind !== 'user') {
    return new Response(signInRequiredPage(locale, profileId), {
      status: 401,
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  }

  const profile = await loadProfile(profileId);
  if (!profile) return new Response('Not found', { status: 404 });

  const evidence = await loadEvidence(profileId);
  const markdown = renderInterviewKit(profile, evidence, locale, await loadKitOptions(profileId));

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
