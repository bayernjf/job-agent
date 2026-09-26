/**
 * 面试准备包 Markdown 下载端点（痛点解决方案批次 1）。
 * 路由：/[locale]/report/[profileId]/interview-kit.md
 * SSR 读取画像快照 + 证据明细，输出可下载的 text/markdown。
 */
import type { APIRoute } from 'astro';
import { loadProfile, loadEvidence, getStorage } from '../../../../lib/db';
import { resolveViewer } from '../../../../lib/auth';
import { isLocale, type Locale } from '../../../../i18n/index.js';
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

export const GET: APIRoute = async ({ params, request }) => {
  const rawLocale = params.locale;
  if (!isLocale(rawLocale)) {
    return new Response('Not found', { status: 404 });
  }
  const locale: Locale = rawLocale;
  const profileId = params.profileId;
  if (!profileId) return new Response('Not found', { status: 404 });

  // 授权分级闸：面试准备包含完整证据外链，仅登录 user 可下载（与报告页面试题墙一致）。
  const viewer = await resolveViewer(request.headers.get('cookie'));
  if (viewer.kind !== 'user') {
    return new Response('Sign in required to download the interview kit.', { status: 401 });
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
