/**
 * 报告页数据装配（Q2 拆分）：把原 [profileId].astro frontmatter 里的
 * 「加载画像 → 派生展示数据 → 授权分级」纯逻辑集中到这里，便于单测；
 * 页面 frontmatter 只负责调用并处理 redirect，模板保持零改动。
 *
 * Astro 专属 API（params / redirect / url）通过输入参数传入，本模块不直接依赖 Astro 全局。
 */
import {
  composeCadenceSummary,
  composeHeadline,
  composeInterviewIntent,
  composePrSummary,
  composeSignalDetail,
  composeSignalLabel,
  composeImprovementSuggestion,
  headlineFactsFromProfile,
  prSummaryFactsFromProfile,
  type EvidenceItem,
  type SkillTag,
  type SkillTagKind,
} from '@jobagent/shared';
import type { StoredProfile } from '@jobagent/storage';
import { isLocale, createTranslator, type Locale, type MessageKey } from '../i18n/index';
import { authenticityClass, formatDateTime } from './format';
import { browserApiBase } from './api-base';
import { loadEvidence, loadProfileRecord } from './db';
import { canViewApplications, canViewGatedContent, resolveViewer } from './auth';

export interface ReportPageInput {
  rawLocale: string | undefined;
  profileId: string | undefined;
  url: URL;
  cookieHeader: string | null;
}

export type ReportPageData =
  | { kind: 'redirect'; to: string }
  | {
      kind: 'ok';
      locale: Locale;
      t: ReturnType<typeof createTranslator>;
      apiBase: string;
      disputeEmail: string;
      profileRecord: StoredProfile;
      profile: NonNullable<StoredProfile['snapshot']>;
      isPartialProfile: boolean;
      isFusedProfile: boolean;
      isHeldForRemoval: boolean;
      headline: string;
      fusionStats: { n: number; labelKey: MessageKey }[];
      isRecruiter: boolean;
      pathname: string;
      recruiterUrl: string;
      candidateUrl: string;
      canViewGated: boolean;
      canUseApplications: boolean;
      loginPlatform: 'github' | 'gitee';
      loginHref: string;
      gateLoginLabel: string;
      gateEvidenceBody: string;
      gateInterviewBody: string;
      resolveEvidence: (refs: string[] | undefined | null) => EvidenceItem[];
      authLabelKey: MessageKey;
      authClass: string;
      skillGroups: Record<SkillTagKind, SkillTag[]>;
      shareUrl: string;
      resumeJobId: string | undefined;
      generatedAt: string;
      since: string;
      until: string;
      interviewKitUrl: string;
      applicationStatusLabels: Record<string, string>;
    };

export async function loadReportPageData(input: ReportPageInput): Promise<ReportPageData> {
  const { rawLocale, profileId, url } = input;
  if (!isLocale(rawLocale)) {
    return { kind: 'redirect', to: '/en/' };
  }
  const locale: Locale = rawLocale;
  const t = createTranslator(locale);

  // API 地址：显式 PUBLIC_API_BASE 优先；Vercel 同域为 /api；本地默认同源
  const apiBase = browserApiBase();

  const importMetaEnv = (import.meta as unknown as { env?: Record<string, string | undefined> })
    .env;
  const disputeEmail =
    importMetaEnv?.PUBLIC_DISPUTE_EMAIL ?? 'dispute@job-agent.bayjf.com';

  // T25 失败显式化：DB 查询异常与"画像不存在"分开处理——
  // 拔掉数据库时报告页说"暂时不可用"而不是"画像不存在"（NFR-6 不向用户暴露原始报错）。
  let dbUnavailable = false;
  let profileRecord: StoredProfile | null = null;
  if (profileId) {
    try {
      profileRecord = await loadProfileRecord(profileId);
    } catch {
      dbUnavailable = true;
    }
  }
  const profile = profileRecord?.snapshot ?? null;

  if (dbUnavailable) {
    return { kind: 'redirect', to: `/${locale}/?unavailable=1` };
  }
  // 画像不存在：渲染 404 状态页（profile 由 profileRecord 解出，两者同生同灭；一并判空以便下游收窄类型）
  if (!profile || !profileRecord) {
    return { kind: 'redirect', to: `/${locale}/?notfound=1` };
  }

  // 采集/分析有缺失时画像落库为 partial（T25）：页面顶部显示"部分数据"标注条
  const isPartialProfile = profileRecord.status === 'partial';

  // 融合画像标识只存在于存储行 subjectPlatform 列（snapshot.subject.platform 恒为主源 github）
  const isFusedProfile = profileRecord?.subjectPlatform === 'all';

  // S3 软挂起：画像已收到未决移除申请（removal_requested_at 非空）时，SSR 顶部标注「处理中」
  const isHeldForRemoval = Boolean(profileRecord?.removalRequestedAt);

  // headline 按读者语言现拼（T07）：快照里的 summary.headline 是数据层英文原文，
  // 中文报告页不该露一句英文；组装只读快照已有事实，不新增结论。
  const headline = composeHeadline(headlineFactsFromProfile(profile), locale);

  // 双源融合去重统计：仅当快照带 fusion 报告且确有镜像合并/去重时展示，全 0 则不渲染
  const fusion = profile.fusion;
  const allFusionStats: { n: number; labelKey: MessageKey }[] = [
    { n: fusion?.mergedMirrors.length ?? 0, labelKey: 'report.fusion.statMirrors' },
    { n: fusion?.dedupedCommitCount ?? 0, labelKey: 'report.fusion.statCommits' },
    { n: fusion?.dedupedPullRequestCount ?? 0, labelKey: 'report.fusion.statPrs' },
    { n: fusion?.dedupedIssueCount ?? 0, labelKey: 'report.fusion.statIssues' },
  ];
  const fusionStats = fusion ? allFusionStats.filter((s) => s.n > 0) : [];

  // 视角：默认求职者；?view=recruiter 为招聘方核验视图（只看可核验证据，隐藏求职建议）
  const isRecruiter = url.searchParams.get('view') === 'recruiter';
  const pathname = url.pathname;
  const recruiterUrl = `${pathname}?view=recruiter`;
  const candidateUrl = pathname;

  // 授权分级闸（2026-09-19）：SSR 解析登录态。未登录（anonymous/demo）看公开门面，
  // 完整证据外链与面试题/面试准备包折叠为登录墙；任何已登录 user（含招聘方）解锁。
  const viewer = await resolveViewer(input.cookieHeader);
  const canViewGated = canViewGatedContent(viewer);
  // 投递管道隐私（#17-F11）：画像一经认领即收归本人，判据与 API requireProfileOwner 一致
  const canUseApplications = canViewApplications(viewer, profileRecord);
  // 登录后回跳当前页（含 ?view=recruiter）；return_to 为同源相对路径，后端再做一次白名单校验。
  // 登录墙按画像主体平台选登录方式：Gitee 画像引导 Gitee 登录，其余（含双源融合，主源 GitHub）走 GitHub。
  const loginPlatform: 'github' | 'gitee' = profile.subject.platform === 'gitee' ? 'gitee' : 'github';
  const loginHref = `${apiBase}/auth/${loginPlatform}/login?return_to=${encodeURIComponent(
    `${pathname}${url.search}`,
  )}`;
  const gateLoginLabel =
    loginPlatform === 'gitee' ? t('report.gate.loginButtonGitee') : t('report.gate.loginButton');
  const gateEvidenceBody =
    loginPlatform === 'gitee' ? t('report.gate.evidenceBodyGitee') : t('report.gate.evidenceBody');
  const gateInterviewBody =
    loginPlatform === 'gitee'
      ? t('report.gate.interviewBodyGitee', { count: profile.interviewQuestions.length })
      : t('report.gate.interviewBody', { count: profile.interviewQuestions.length });

  // 证据明细（含完整外链 URL）：画像快照里只有 evidenceId，核验视图/面试准备包需要可点击链接
  const evidenceList = profileId ? await loadEvidence(profileId) : [];
  const evidenceById = new Map(evidenceList.map((e) => [e.evidenceId, e]));
  const resolveEvidence = (refs: string[] | undefined | null): EvidenceItem[] =>
    (refs ?? [])
      .map((ref) => evidenceById.get(ref))
      .filter((e): e is EvidenceItem => Boolean(e && e.url));

  // 真实性状态文案 key
  const authLabelKey = `report.authenticity.${profile.authenticity.status}` as MessageKey;
  const authClass = authenticityClass(profile.authenticity.status);

  // 能力标签按 kind 分组
  const skillGroups = {
    language: profile.skillTags.filter((s) => s.kind === 'language'),
    framework: profile.skillTags.filter((s) => s.kind === 'framework'),
    domain: profile.skillTags.filter((s) => s.kind === 'domain'),
  };

  const shareUrl = url.href;
  // 扩展面板"生成简历"深链：?resumeJob=<jobId>，ResumeBuilder mount 后自动生成
  const resumeJobId = url.searchParams.get('resumeJob') ?? undefined;
  const generatedAt = formatDateTime(profile.generatedAt, locale);
  const since = formatDateTime(profile.dataWindow.since, locale);
  const until = formatDateTime(profile.dataWindow.until, locale);
  const interviewKitUrl = `${pathname}/interview-kit.md`;

  // 投递状态文案映射（传给 ApplicationTracker island）
  const applicationStatusLabels = {
    saved: t('applications.status.saved'),
    applied: t('applications.status.applied'),
    viewed: t('applications.status.viewed'),
    interview: t('applications.status.interview'),
    offer: t('applications.status.offer'),
    rejected: t('applications.status.rejected'),
    withdrawn: t('applications.status.withdrawn'),
  };

  return {
    kind: 'ok',
    locale,
    t,
    apiBase,
    disputeEmail,
    profileRecord,
    profile,
    isPartialProfile,
    isFusedProfile,
    isHeldForRemoval,
    headline,
    fusionStats,
    isRecruiter,
    pathname,
    recruiterUrl,
    candidateUrl,
    canViewGated,
    canUseApplications,
    loginPlatform,
    loginHref,
    gateLoginLabel,
    gateEvidenceBody,
    gateInterviewBody,
    resolveEvidence,
    authLabelKey,
    authClass,
    skillGroups,
    shareUrl,
    resumeJobId,
    generatedAt,
    since,
    until,
    interviewKitUrl,
    applicationStatusLabels,
  };
}

// 模板里仍直接使用这些 compose* helper（next-steps / signals / interview 等 section），
// 统一从本模块 re-export，页面只从一处导入，避免散落在页面 frontmatter。
export {
  composeImprovementSuggestion,
  composeInterviewIntent,
  composeSignalDetail,
  composeSignalLabel,
  prSummaryFactsFromProfile,
  composePrSummary,
  composeCadenceSummary,
};
