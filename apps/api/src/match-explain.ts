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
import type { JobPostingSighting, StoredEvidence } from '@jobagent/storage';

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

/**
 * 判定"再上架"所需的下架静默天数：同一岗位文本此前最后一次被源站列出，
 * 到本次这条重新出现，中间至少静默这么久才算"消失过又回来"。
 * 3 天足以排除同一在招岗位跨源/跨日的正常重复入池（那不是 ghost job 信号）。
 */
export const REPOST_MIN_DARK_DAYS = 3;

const DAY_MS = 86_400_000;

/** 一条岗位的再上架观察：此前静默出现过几次，最早那次何时入池。 */
export interface RepostObservation {
  priorListings: number;
  earliestFirstSeenAt: string;
}

/**
 * 按内部主键统计"同一岗位文本此前消失过又回来"（重复上架 / ghost job 弱信号）。
 *
 * 判据刻意用 `last_seen_at`（源站最后一次列出它）而不是 `first_seen_at`：后者只反映
 * 我们的采集进度，同一在招岗位今天被第二个源抓到会伪装成"39 天前出现过"。
 * 静默口径要求早于本行 `first_seen_at` ≥ {@link REPOST_MIN_DARK_DAYS} 天就再没被列过，
 * 跨源同日重复因此天然不计入。`normalized_key` 为空（自建 JD）或时间戳解析不出时
 * 不产观察——宁可少一个提示，也不给一个错的日期。
 * 只出计数与时间戳，措辞由渲染侧按 locale 现拼。
 */
export function repostObservations(
  rows: readonly Pick<JobPostingSighting, 'id' | 'normalizedKey' | 'firstSeenAt'>[],
  sightings: readonly JobPostingSighting[],
  minDarkDays: number = REPOST_MIN_DARK_DAYS,
): Record<string, RepostObservation> {
  const byKey = new Map<string, JobPostingSighting[]>();
  for (const s of sightings) {
    if (!s.normalizedKey) continue;
    const bucket = byKey.get(s.normalizedKey);
    if (bucket) bucket.push(s);
    else byKey.set(s.normalizedKey, [s]);
  }

  const out: Record<string, RepostObservation> = {};
  for (const row of rows) {
    const bucket = row.normalizedKey ? byKey.get(row.normalizedKey) : undefined;
    if (!bucket) continue;
    const appearedAt = Date.parse(row.firstSeenAt);
    if (Number.isNaN(appearedAt)) continue;
    const darkBefore = appearedAt - minDarkDays * DAY_MS;
    let priorListings = 0;
    let earliest = '';
    for (const s of bucket) {
      if (s.id === row.id) continue;
      const lastSeen = Date.parse(s.lastSeenAt);
      if (Number.isNaN(lastSeen) || lastSeen > darkBefore) continue;
      priorListings += 1;
      if (!earliest || s.firstSeenAt < earliest) earliest = s.firstSeenAt;
    }
    if (priorListings > 0) out[row.id] = { priorListings, earliestFirstSeenAt: earliest };
  }
  return out;
}
