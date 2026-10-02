import {
  matchScoreTier,
  type MatchBoost,
  type MatchGap,
  type MatchReason,
  type MatchReport,
  type MatchScoreTier,
} from '@jobagent/shared';
import { DEFAULT_MAX_GAPS, DEFAULT_CANDIDATE_LIMIT, AGENT_RULE_VERSION } from './rules.js';
import {
  isPreferredCompany,
  normalizeText,
  passesQualityGate,
  type PreferencePostingLike,
} from './preferences.js';

/**
 * 可解释匹配报告 + 候选选择（设计 §3.2「评」）。
 *
 * 报告只存 **code + 事实**（命中的画像技能、岗位标签、字段与分值），不写任何自然语言句子：
 * 渲染侧按 code 取本地化文案现拼（对齐 T23/T33 的纪律，中文页面不允许贴英文句子）。
 * 分值口径与 job-source 的 MATCH_FIELD_WEIGHTS 完全一致（测试钉住），但不 import 它，
 * 以免把 storage 依赖拖进纯内核。
 */

/** 岗位字段命中权重（= job-source MATCH_FIELD_WEIGHTS）。 */
export const MATCH_FIELD_POINTS: Readonly<Record<'title' | 'tags' | 'description', number>> = {
  title: 3,
  tags: 2,
  description: 1,
};

export type MatchFieldLike = 'title' | 'tags' | 'description';

/** 与 job-source `JobMatch` 结构性兼容的最小子集。 */
export interface MatchLike {
  score: number;
  matchedSkills: readonly string[];
  fieldScores: { title: number; tags: number; description: number };
  skillHits: readonly {
    skill: string;
    score: number;
    fields: readonly MatchFieldLike[];
  }[];
}

const REASON_CODE_BY_FIELD: Readonly<Record<MatchFieldLike, MatchReason['code']>> = {
  title: 'title_match',
  tags: 'tag_match',
  description: 'description_match',
};

/** 字段 → 理由（一个技能可能同时命中多个字段，逐个出码，与 job-source 的 skillHits 一一对应）。 */
export function matchReasons(match: Pick<MatchLike, 'skillHits'>): MatchReason[] {
  const reasons: MatchReason[] = [];
  for (const hit of match.skillHits) {
    for (const field of hit.fields) {
      reasons.push({
        code: REASON_CODE_BY_FIELD[field],
        skill: hit.skill,
        points: MATCH_FIELD_POINTS[field],
      });
    }
  }
  return reasons;
}

/**
 * 缺口 = 岗位标签在画像技能里找不到对应（事实陈述：「岗位提到 X，你的画像里没有 X 的证据」）。
 * 只报标签，不从职位描述里做语义猜测（语义理解是 LLM 那一档，阶段 1 默认关闭）。
 */
export function matchGaps(
  tags: readonly string[],
  profileSkills: readonly string[],
  maxGaps: number = DEFAULT_MAX_GAPS,
): MatchGap[] {
  const known = new Set(profileSkills.map((s) => normalizeText(s)).filter((s) => s.length > 0));
  const seen = new Set<string>();
  const gaps: MatchGap[] = [];
  for (const tag of tags) {
    const norm = normalizeText(tag);
    if (norm.length === 0 || seen.has(norm) || known.has(norm)) continue;
    seen.add(norm);
    gaps.push({ code: 'tag_not_in_profile', tag: tag.trim() });
    if (gaps.length >= maxGaps) break;
  }
  return gaps;
}

export interface BuildMatchReportInput {
  match: MatchLike;
  /** 岗位标签原文（用于缺口） */
  tags?: readonly string[];
  /** 画像技能名（skillTags.name），用于判断某个标签是否已有证据 */
  profileSkills: readonly string[];
  maxGaps?: number;
}

/** 组装可解释匹配报告（tier 复用 shared.matchScoreTier，口径与报告页/简历完全一致）。 */
export function buildMatchReport(input: BuildMatchReportInput): MatchReport {
  const { match } = input;
  const tier = matchScoreTier(match.score, match.matchedSkills.length);
  const gaps = matchGaps(input.tags ?? [], input.profileSkills, input.maxGaps ?? DEFAULT_MAX_GAPS);
  const suggestedBoost: MatchBoost[] = gaps.map((gap) => ({
    code: 'add_evidence_for_tag',
    skill: gap.tag,
  }));
  return {
    ruleVersion: AGENT_RULE_VERSION,
    score: match.score,
    tier,
    fieldScores: {
      title: match.fieldScores.title,
      tags: match.fieldScores.tags,
      description: match.fieldScores.description,
    },
    matchedSkills: [...match.matchedSkills],
    reasons: matchReasons(match),
    gaps,
    suggestedBoost,
  };
}

export interface CandidateLike {
  match: MatchLike;
  posting: PreferencePostingLike;
}

export interface SelectCandidatesOptions {
  /** 质量闸最低档（偏好 minTier） */
  minTier: MatchScoreTier;
  /** 本轮最多产出多少条 */
  limit?: number;
  /** 已经出过票据/已投递/已保存的岗位 id（本轮不再重复推） */
  excludeJobIds?: ReadonlySet<string>;
  /** 公司白名单（命中排在最前） */
  preferredCompany?: (company: string) => boolean;
}

/**
 * 标题或标签命中守卫（产品口径 2026-10-03，AGENT_RULE_VERSION 0.2）：
 * 仅「描述提到技能」不再单独构成候选资格——岗位必须在标题或标签里命中至少一个画像技能。
 * 判定依据与 matchReasons 同源（skillHits.fields），防长描述把技能提及多次、
 * 把「描述沾边」的不相关岗位（如管理岗）塞进推荐列表（宁少勿滥，对齐偏好硬过滤口径）。
 */
export function passesTitleOrTagGuard(match: Pick<MatchLike, 'skillHits'>): boolean {
  return match.skillHits.some((hit) => hit.fields.includes('title') || hit.fields.includes('tags'));
}

/**
 * 候选选择：先过资格守卫（标题/标签命中）与质量闸，再排优先级，最后截断。
 * 排序键（稳定、可解释）：白名单公司 → 匹配分降序 → 发布时间降序（ISO 字符串可直接比较）。
 * 不做「凑数」：一条都没过闸就返回空数组，由编排壳走 rescan 而不是硬推低分岗。
 */
export function selectCandidates<T extends CandidateLike>(
  items: readonly T[],
  options: SelectCandidatesOptions,
): T[] {
  const limit = options.limit ?? DEFAULT_CANDIDATE_LIMIT;
  const excluded = options.excludeJobIds ?? new Set<string>();
  const scored = items
    .filter((item) => !excluded.has(item.posting.jobId))
    .filter((item) => passesTitleOrTagGuard(item.match))
    .map((item) => ({
      item,
      tier: matchScoreTier(item.match.score, item.match.matchedSkills.length),
      priority: options.preferredCompany?.(item.posting.company) ? 1 : 0,
    }))
    .filter((entry) => passesQualityGate(entry.tier, options.minTier));

  scored.sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    if (b.item.match.score !== a.item.match.score) return b.item.match.score - a.item.match.score;
    return b.item.posting.postedAt.localeCompare(a.item.posting.postedAt);
  });

  return scored.slice(0, Math.max(0, limit)).map((entry) => entry.item);
}

/** 便捷组合：白名单判定 + 候选选择（编排壳一行调用）。 */
export function selectCandidatesForPreference<T extends CandidateLike>(
  items: readonly T[],
  options: Omit<SelectCandidatesOptions, 'preferredCompany'> & {
    preferredCompanyTerms?: readonly string[];
  },
): T[] {
  const terms = options.preferredCompanyTerms ?? [];
  return selectCandidates(items, {
    ...options,
    preferredCompany:
      terms.length > 0 ? (company: string) => isPreferredCompany(company, { companyWhitelist: [...terms] }) : undefined,
  });
}
