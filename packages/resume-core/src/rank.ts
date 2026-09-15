/**
 * 岗位定向排序（纯函数、无 I/O）：
 *  - rankSkills：画像技能拆成「岗位命中（置顶）」与「其他（保留不删）」两组；
 *  - rankEvidence：取支撑命中技能的证据，按"支撑命中数 > 证据强度 > 时间新"排序。
 * 定向只做选择与排序，绝不改写技能名/证据 claim 等事实。
 */
import type { EvidenceItem, EvidenceSourceType, SkillTag } from '@jobagent/shared';

/** 归一化：小写、去首尾空白，用于技能名/标签的保守整词对应（matchJobs 已做整词匹配） */
export function normalizeName(s: string): string {
  return s.trim().toLowerCase();
}

const DEPTH_RANK: Record<SkillTag['depth'], number> = { proficient: 1, used: 0 };

/** 证据强度权重：外部贡献 > PR > Issue > 文件 > commit > 仓库元信息 */
const EVIDENCE_STRENGTH: Record<EvidenceSourceType, number> = {
  contribution: 5,
  pr: 4,
  issue: 3,
  file: 2,
  commit: 1,
  repo: 0,
};

export interface RankedSkill {
  skill: SkillTag;
  /** 该技能在岗位上的命中贡献分（other 组为 0） */
  hitScore: number;
}

/**
 * 拆分并排序技能。
 * @param skills 画像 skillTags（事实全集，不丢）
 * @param matchedSkills matchJobs 命中的技能名（原始写法）
 * @param hitScoreByName 命中技能名 -> skillHits.score（命中组内部排序用）
 */
export function rankSkills(
  skills: readonly SkillTag[],
  matchedSkills: readonly string[],
  hitScoreByName: ReadonlyMap<string, number>,
): { matched: RankedSkill[]; other: RankedSkill[] } {
  const matchedNorm = new Set(matchedSkills.map(normalizeName));
  const matched: RankedSkill[] = [];
  const other: RankedSkill[] = [];

  for (const skill of skills) {
    const isMatched = matchedNorm.has(normalizeName(skill.name));
    const hitScore = hitScoreByName.get(normalizeName(skill.name)) ?? 0;
    (isMatched ? matched : other).push({ skill, hitScore });
  }

  // 命中组：岗位命中分降序 → 深度 → 置信度
  matched.sort((a, b) => {
    if (b.hitScore !== a.hitScore) return b.hitScore - a.hitScore;
    const depth = DEPTH_RANK[b.skill.depth] - DEPTH_RANK[a.skill.depth];
    if (depth !== 0) return depth;
    return b.skill.confidence - a.skill.confidence;
  });
  // 其他组：深度 → 置信度（保留事实，仅排序在后）
  other.sort((a, b) => {
    const depth = DEPTH_RANK[b.skill.depth] - DEPTH_RANK[a.skill.depth];
    if (depth !== 0) return depth;
    return b.skill.confidence - a.skill.confidence;
  });

  return { matched, other };
}

export interface RankedEvidence {
  item: EvidenceItem;
  /** 该证据支撑哪些命中技能（技能名，画像原文写法） */
  supportsSkills: string[];
}

/**
 * 选出支撑命中技能的证据并排序。
 * @param allEvidence 画像证据全集
 * @param matchedSkills 命中技能（带各自 evidenceRefs）
 * @param limit highlights 上限
 */
export function rankEvidence(
  allEvidence: readonly EvidenceItem[],
  matchedSkills: readonly SkillTag[],
  limit: number,
): RankedEvidence[] {
  // evidenceId -> 它支撑的命中技能名（一个证据可被多技能引用）
  const supportsById = new Map<string, Set<string>>();
  for (const skill of matchedSkills) {
    for (const ref of skill.evidenceRefs) {
      const set = supportsById.get(ref) ?? new Set<string>();
      set.add(skill.name);
      supportsById.set(ref, set);
    }
  }

  const picked: RankedEvidence[] = [];
  for (const item of allEvidence) {
    const supports = supportsById.get(item.evidenceId);
    if (!supports || supports.size === 0) continue;
    picked.push({ item, supportsSkills: [...supports] });
  }

  picked.sort((a, b) => {
    // 1) 支撑的命中技能越多越靠前
    const byCount = b.supportsSkills.length - a.supportsSkills.length;
    if (byCount !== 0) return byCount;
    // 2) 证据强度
    const byStrength = EVIDENCE_STRENGTH[b.item.sourceType] - EVIDENCE_STRENGTH[a.item.sourceType];
    if (byStrength !== 0) return byStrength;
    // 3) 时间新→旧；无时间排最后
    const ta = a.item.occurredAt;
    const tb = b.item.occurredAt;
    if (ta && tb) return tb.localeCompare(ta);
    if (tb) return 1;
    if (ta) return -1;
    return 0;
  });

  return limit > 0 ? picked.slice(0, limit) : picked;
}
