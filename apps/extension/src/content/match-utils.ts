/**
 * 扩展面板匹配 UI 的纯函数工具（无 React 依赖，便于单测）。
 * 匹配分档与证据链接解析，与报告页 JobRecommendations 逻辑对齐。
 */
import type { EvidenceBrief } from '../lib/api.js';
import type { MessageKey } from '../i18n/index.js';

/** 匹配分三档（与报告页一致）：high ≥80% 满分，mid ≥40%，low <40%。满分=技能数×6（title3+tags2+desc1）。 */
export type MatchTier = 'high' | 'mid' | 'low';

export function matchTier(score: number, matchedSkills: readonly string[]): MatchTier {
  if (matchedSkills.length === 0) return 'low';
  const max = matchedSkills.length * 6;
  const ratio = score / max;
  if (ratio >= 0.8) return 'high';
  if (ratio >= 0.4) return 'mid';
  return 'low';
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
