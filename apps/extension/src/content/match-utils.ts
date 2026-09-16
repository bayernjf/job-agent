/**
 * 扩展面板匹配 UI 的纯函数工具（无 React 依赖，便于单测）。
 * 匹配分档复用 shared.matchScoreTier（与报告页同一事实源），证据链接解析为扩展专属。
 */
import { matchScoreTier, type MatchScoreTier } from '@jobagent/shared';
import type { EvidenceBrief } from '../lib/api.js';
import type { MessageKey } from '../i18n/index.js';

/** 匹配分三档，类型复用 shared，panel 侧保留语义别名。 */
export type MatchTier = MatchScoreTier;

export function matchTier(score: number, matchedSkills: readonly string[]): MatchTier {
  return matchScoreTier(score, matchedSkills.length);
}

export const MATCH_TIER_KEY: Record<MatchTier, MessageKey> = {
  high: 'match.high',
  mid: 'match.mid',
  low: 'match.low',
};

/** 把 evidenceRefs 解析为可展示的证据链接（去重、过滤字典中不存在的、label 截 60 字符）。 */
export function resolveEvidenceLinks(
  refs: readonly string[],
  dict: Record<string, EvidenceBrief> | undefined,
): Array<{ url: string; label: string }> {
  if (!dict) return [];
  const seen = new Set<string>();
  const out: Array<{ url: string; label: string }> = [];
  for (const ref of refs) {
    const e = dict[ref];
    if (!e || seen.has(e.url)) continue;
    seen.add(e.url);
    const label = e.claim.length > 60 ? `${e.claim.slice(0, 57)}…` : e.claim;
    out.push({ url: e.url, label });
  }
  return out;
}

/**
 * 报告页基址：生产同域反代（部署形态 A）下报告页与 API 同 origin，故默认取 apiBase 的 origin；
 * 本地开发 API(3000)/Report(4321) 跨端口时，用户可在设置里用 reportBase 覆盖。
 */
export function resolveReportBase(apiBase: string, reportBaseOverride?: string | null): string {
  const override = reportBaseOverride?.trim();
  if (override) return override.replace(/\/+$/, '');
  try {
    return new URL(apiBase).origin;
  } catch {
    return apiBase.replace(/\/+$/, '');
  }
}

/**
 * 岗位定向简历深链：新标签打开报告页并经 ?resumeJob=<jobId> 自动触发 ResumeBuilder。
 * 深链只携带 profileId 与岗位内部 id，不附加任何 demo 会话标识（普通 anchor 导航）。
 */
export function resumeDeepLink(
  reportBase: string,
  locale: 'zh-CN' | 'en',
  profileId: string,
  jobId: string,
): string {
  const base = reportBase.replace(/\/+$/, '');
  const loc = locale === 'en' ? 'en' : 'zh-CN';
  return `${base}/${loc}/report/${encodeURIComponent(profileId)}?resumeJob=${encodeURIComponent(jobId)}`;
}
