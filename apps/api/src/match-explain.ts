/**
 * 匹配可解释性装配（决策 #10）：把 job-source 产出的字段级匹配结果
 * （skillHits / fieldScores）与画像侧 SkillTag（kind/depth/confidence/evidenceRefs）
 * 关联，并收集命中技能引用到的证据，形成「为什么推荐 + 可回溯证据」。
 *
 * 纯函数、无 I/O：岗位文本匹配仍在 job-source，画像/证据概念只在本层（api）出现，
 * 保持 job-source 不依赖画像模型的既有边界。
 */
import type { JobPosting, SkillTag } from '@jobagent/shared';
import type { JobMatch, MatchField } from '@jobagent/job-source';
import type { StoredEvidence } from '@jobagent/storage';

/** 单个命中技能的推荐理由：匹配贡献 + 该技能在画像中的元数据与证据指针。 */
export interface SkillReason {
  skill: string;
  /** 该技能对这条岗位的贡献分（来自 job-source skillHit） */
  score: number;
  /** 命中了岗位的哪些字段 */
  fields: MatchField[];
  kind: SkillTag['kind'];
  depth: SkillTag['depth'];
  confidence: number;
  /** -> evidence 表行 id（EvidenceItem.evidenceId），可在 evidence 字典回溯 */
  evidenceRefs: string[];
}

/** 精简证据字典项：只带前端可回溯所需，不搬运整行存储字段。 */
export interface EvidenceBrief {
  sourceType: string;
  url: string;
  claim: string;
}

/** 技能名 -> 画像 SkillTag 的索引（技能名来自同一画像，精确对应）。 */
export function skillTagMap(tags: readonly SkillTag[]): Map<string, SkillTag> {
  return new Map(tags.map((tag) => [tag.name, tag]));
}

/**
 * 把一条岗位匹配的 skillHits 与画像技能关联成推荐理由。
 * tags 为 undefined（调用方只显式传了技能名、没有画像）时返回 undefined，
 * 调用方据此决定是否在响应里带 skillReasons。
 */
export function buildSkillReasons<T extends JobPosting>(
  match: JobMatch<T>,
  tags: Map<string, SkillTag> | undefined,
): SkillReason[] | undefined {
  if (!tags) return undefined;
  const reasons: SkillReason[] = [];
  for (const hit of match.skillHits) {
    const tag = tags.get(hit.skill);
    if (!tag) continue;
    reasons.push({
      skill: hit.skill,
      score: hit.score,
      fields: hit.fields,
      kind: tag.kind,
      depth: tag.depth,
      confidence: tag.confidence,
      evidenceRefs: tag.evidenceRefs,
    });
  }
  return reasons;
}

/**
 * 收集本次所有推荐理由引用到的证据，输出 id -> 精简证据字典。
 * 只包含命中技能实际引用的证据 id，避免把整份画像证据搬给前端。
 */
export function collectEvidence(
  reasons: readonly SkillReason[],
  rows: readonly StoredEvidence[],
): Record<string, EvidenceBrief> {
  const wanted = new Set<string>();
  for (const reason of reasons) {
    for (const id of reason.evidenceRefs) wanted.add(id);
  }
  const dict: Record<string, EvidenceBrief> = {};
  for (const row of rows) {
    if (wanted.has(row.id)) {
      dict[row.id] = { sourceType: row.sourceType, url: row.url, claim: row.claim };
    }
  }
  return dict;
}
