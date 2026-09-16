/**
 * 人才检索（企业侧筛选工作台 P-A/P-B，痛点解决方案批次 2，2026-09-16）。
 *
 * 数据源是已生成的 profiles 快照（status='complete'），不触发新采集。
 * 技能/真实性/置信度都嵌在 snapshot JSON 中；为避免 SQLite/Postgres 的 JSON SQL
 * 方言差异，仓储层只负责按状态取出最近一批画像，**过滤与排序全部收敛到本文件的
 * 纯函数**，两方言共用同一套逻辑（方言差异只允许出现在仓储内部，且这里降到零）。
 */
import type { AuthenticityStatus, SkillTagKind, SkillTagDepth } from '@jobagent/shared';
import type { StoredProfile } from './profile.js';

/** 检索结果中的精简技能（不含 evidenceRefs，列表页只需要名称/类别/深度/置信度） */
export interface CandidateSkill {
  name: string;
  kind: SkillTagKind;
  depth: SkillTagDepth;
  confidence: number;
}

/** 候选人摘要（筛选工作台列表项；完整画像走 GET /profiles/:id） */
export interface CandidateSummary {
  profileId: string;
  platform: string;
  login: string;
  displayName?: string;
  avatarUrl?: string;
  profileUrl: string;
  claimed: boolean;
  headline: string;
  seniorityBand?: string;
  authenticity: {
    status: AuthenticityStatus;
    confidence: number;
  };
  skills: CandidateSkill[];
  skillCount: number;
  /** 命中检索条件的技能名（未按技能过滤时与 skills 名称一致或为空） */
  matchedSkills: string[];
  updatedAt: string;
}

export type CandidateSortBy = 'confidence_desc' | 'skill_count_desc' | 'recent';

export interface CandidateSearchQuery {
  /** 自由文本：拆词后每个词都要命中 login/displayName/headline/技能名之一（词间 AND，大小写不敏感） */
  keyword?: string;
  /** 技能名过滤 */
  skills?: string[];
  /** 多技能匹配方式：any=命中任一（默认，召回优先）；all=全部命中（精准） */
  skillMatch?: 'any' | 'all';
  /** 真实性状态白名单（OR）；不传表示不限 */
  authenticity?: AuthenticityStatus[];
  /** 只保留 authenticity.confidence >= 该值（0..1） */
  minConfidence?: number;
  /** 平台过滤 */
  platform?: string;
  sortBy?: CandidateSortBy;
  limit?: number;
  offset?: number;
}

/** 从完整画像存储行投影为候选人摘要（snapshot 为空返回 null） */
export function toCandidateSummary(row: StoredProfile): CandidateSummary | null {
  const profile = row.snapshot;
  if (!profile) return null;
  const skills: CandidateSkill[] = profile.skillTags.map((s) => ({
    name: s.name,
    kind: s.kind,
    depth: s.depth,
    confidence: s.confidence,
  }));
  return {
    profileId: row.id,
    platform: row.subjectPlatform,
    login: profile.subject.login,
    ...(profile.subject.displayName ? { displayName: profile.subject.displayName } : {}),
    ...(profile.subject.avatarUrl ? { avatarUrl: profile.subject.avatarUrl } : {}),
    profileUrl: profile.subject.profileUrl,
    claimed: profile.subject.claimed,
    headline: profile.summary.headline,
    ...(profile.summary.seniorityHint?.band
      ? { seniorityBand: profile.summary.seniorityHint.band }
      : {}),
    authenticity: {
      status: profile.authenticity.status,
      confidence: profile.authenticity.confidence,
    },
    skills,
    skillCount: skills.length,
    matchedSkills: [],
    updatedAt: row.updatedAt,
  };
}

function keywordWords(kw: string | undefined): string[] {
  return (kw ?? '')
    .split(/\s+/)
    .map((w) => w.trim().toLowerCase())
    .filter((w) => w.length > 0);
}

function normalize(s: string): string {
  return s.toLowerCase();
}

/** 判断单个候选人是否满足过滤条件；返回 null 表示被过滤掉，否则回填 matchedSkills。 */
function evaluate(
  candidate: CandidateSummary,
  query: CandidateSearchQuery,
): CandidateSummary | null {
  if (query.platform && candidate.platform !== query.platform) return null;

  if (query.authenticity && query.authenticity.length > 0) {
    if (!query.authenticity.includes(candidate.authenticity.status)) return null;
  }

  if (query.minConfidence !== undefined) {
    if (candidate.authenticity.confidence < query.minConfidence) return null;
  }

  // 技能过滤（大小写不敏感，按技能名匹配）
  let matchedSkills: string[] = [];
  if (query.skills && query.skills.length > 0) {
    const wanted = query.skills.map(normalize);
    const haveNames = candidate.skills.map((s) => s.name);
    const haveLower = haveNames.map(normalize);
    const matchedLower = wanted.filter((w) => haveLower.some((h) => h.includes(w) || w.includes(h)));
    if (query.skillMatch === 'all') {
      if (matchedLower.length !== wanted.length) return null;
    } else if (matchedLower.length === 0) {
      return null;
    }
    // 回填画像中的原始技能名（保持展示大小写）
    matchedSkills = haveNames.filter((_, i) =>
      wanted.some((w) => {
        const h = haveLower[i]!;
        return h.includes(w) || w.includes(h);
      }),
    );
  }

  // 关键词：词间 AND，每个词命中 login/displayName/headline/任一技能名
  const haystacks = [
    candidate.login,
    candidate.displayName ?? '',
    candidate.headline,
    ...candidate.skills.map((s) => s.name),
  ].map(normalize);
  for (const word of keywordWords(query.keyword)) {
    if (!haystacks.some((h) => h.includes(word))) return null;
  }

  return { ...candidate, matchedSkills };
}

function compare(a: CandidateSummary, b: CandidateSummary, sortBy: CandidateSortBy): number {
  switch (sortBy) {
    case 'skill_count_desc': {
      const byCount = b.skillCount - a.skillCount;
      return byCount !== 0 ? byCount : b.authenticity.confidence - a.authenticity.confidence;
    }
    case 'recent': {
      const byDate = b.updatedAt.localeCompare(a.updatedAt);
      return byDate !== 0 ? byDate : b.authenticity.confidence - a.authenticity.confidence;
    }
    case 'confidence_desc':
    default: {
      const byConfidence = b.authenticity.confidence - a.authenticity.confidence;
      return byConfidence !== 0 ? byConfidence : b.skillCount - a.skillCount;
    }
  }
}

export interface CandidateSearchResult {
  items: CandidateSummary[];
  /** 过滤后、分页前的总数 */
  total: number;
}

/**
 * 对仓储取出的完整画像行做过滤、排序、分页（纯函数，双方言共用）。
 * 仓储应只做 status='complete' 的粗筛并给出扫描上限，精细条件在此处理。
 */
export function searchCandidates(
  rows: StoredProfile[],
  query: CandidateSearchQuery,
): CandidateSearchResult {
  const sortBy: CandidateSortBy = query.sortBy ?? 'confidence_desc';
  const matched = rows
    .map(toCandidateSummary)
    .filter((c): c is CandidateSummary => c !== null)
    .map((c) => evaluate(c, query))
    .filter((c): c is CandidateSummary => c !== null)
    .sort((a, b) => compare(a, b, sortBy));

  const total = matched.length;
  const offset = query.offset ?? 0;
  const limit = query.limit ?? 20;
  const items = matched.slice(offset, offset + limit);
  return { items, total };
}
