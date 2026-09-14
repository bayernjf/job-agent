/**
 * 能力画像 ↔ 岗位匹配（P2-D 消费侧，纯函数、无 I/O）。
 *
 * 输入一批已检索出的岗位 + 画像技能名（analyzer-core 产出的 skillTags.name），
 * 在岗位 title / tags / description 上做可解释的加权命中打分，输出按相关度
 * 排序的结果。每条结果不仅给总分和命中技能，还给：
 *   - fieldScores：分数在「标题 / 标签 / 正文」三个字段上的贡献分解（合计=总分）；
 *   - skillHits：每个命中技能各自命中了哪些字段、贡献多少分。
 * 上层（apps/api）再把 skillHits 与画像 SkillTag（kind/depth/evidenceRefs）关联，
 * 即可向用户解释「为什么推荐这个岗位、由哪些可回溯证据支撑」（决策 #10）。
 *
 * 保守原则：
 *   - 至少命中一个技能才返回（score>0），不做语义近似/向量召回；
 *   - 词边界匹配，归一化小写、去标点，避免 "java" 误命中 "javascript"；
 *   - remote / 薪资 / 源为硬过滤，打分只负责相关度排序。
 * 该模块不依赖数据库、网络与画像概念，可对固定输入做单测。
 */
import type { JobPosting, JobSource } from '@jobagent/shared';
import { normalizeSegment } from '../normalize/dedupe-key.js';

/** 岗位上可被技能命中的字段。 */
export type MatchField = 'title' | 'tags' | 'description';

/** 字段命中权重：标题最能代表岗位，标签次之，正文兜底。导出供展示层解释分数构成。 */
export const MATCH_FIELD_WEIGHTS: Readonly<Record<MatchField, number>> = {
  title: 3,
  tags: 2,
  description: 1,
};

export interface JobMatchCriteria {
  /** 画像技能名（skillTags.name），至少一个；为空直接返回空结果 */
  skills: readonly string[];
  /** 硬过滤：只要远程岗 */
  remote?: boolean;
  /** 硬过滤：COALESCE(salaryMax, salaryMin) >= 该值（USD）；无薪资数据的岗位不满足 */
  salaryMinUsd?: number;
  /** 硬过滤：只要这些源 */
  sources?: readonly JobSource[];
  /** 返回上限（默认不截断） */
  limit?: number;
}

/** 单个画像技能在某条岗位上的命中情况（匹配可解释性的最小单元）。 */
export interface SkillHit {
  /** 画像技能原始写法 */
  skill: string;
  /** 该技能在命中字段上的累计贡献分 */
  score: number;
  /** 命中的字段，按 title → tags → description 顺序去重排列 */
  fields: MatchField[];
}

/** 总分在三个字段上的分解；title + tags + description === score。 */
export interface FieldScores {
  title: number;
  tags: number;
  description: number;
}

export interface JobMatch<T extends JobPosting = JobPosting> {
  posting: T;
  /** 加权相关度分（越高越相关），等于 fieldScores 三项之和 */
  score: number;
  /** 命中的画像技能（原始写法，去重，按首次命中顺序）；等价于 skillHits.map(h => h.skill) */
  matchedSkills: string[];
  /** 分数在标题/标签/正文上的分解（合计等于 score） */
  fieldScores: FieldScores;
  /** 每个命中技能的字段级命中明细，顺序与 matchedSkills 一致 */
  skillHits: SkillHit[];
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 归一化文本里是否包含「整词」技能（归一后仅字母数字与空格，用词边界）。 */
function hasSkill(haystackNorm: string, skillNorm: string): boolean {
  if (skillNorm.length === 0) return false;
  const re = new RegExp(`(?:^|\\s)${escapeRegExp(skillNorm)}(?:\\s|$)`);
  return re.test(haystackNorm);
}

function passesHardFilters(posting: JobPosting, criteria: JobMatchCriteria): boolean {
  if (criteria.remote === true && posting.remote !== true) return false;
  if (criteria.sources && !criteria.sources.includes(posting.source)) return false;
  if (criteria.salaryMinUsd !== undefined) {
    const ref = posting.salaryMax ?? posting.salaryMin ?? null;
    if (ref === null || ref < criteria.salaryMinUsd) return false;
  }
  return true;
}

/**
 * 对岗位按画像技能打分排序。
 * 泛型 T 保留调用方传入的岗位具体类型（如 StoredJobPosting）。
 */
export function matchJobs<T extends JobPosting>(
  postings: readonly T[],
  criteria: JobMatchCriteria,
): Array<JobMatch<T>> {
  const skills = criteria.skills.map((s) => s.trim()).filter((s) => s.length > 0);
  if (skills.length === 0) return [];

  const matches: Array<JobMatch<T>> = [];
  for (const posting of postings) {
    if (!passesHardFilters(posting, criteria)) continue;

    const titleNorm = normalizeSegment(posting.title);
    const tagsNorm = normalizeSegment((posting.tags ?? []).join(' '));
    const descNorm = normalizeSegment(posting.description ?? '');

    const fieldScores: FieldScores = { title: 0, tags: 0, description: 0 };
    const skillHits: SkillHit[] = [];
    for (const skill of skills) {
      const skillNorm = normalizeSegment(skill);
      const fields: MatchField[] = [];
      let skillScore = 0;
      if (hasSkill(titleNorm, skillNorm)) {
        fields.push('title');
        skillScore += MATCH_FIELD_WEIGHTS.title;
        fieldScores.title += MATCH_FIELD_WEIGHTS.title;
      }
      if (hasSkill(tagsNorm, skillNorm)) {
        fields.push('tags');
        skillScore += MATCH_FIELD_WEIGHTS.tags;
        fieldScores.tags += MATCH_FIELD_WEIGHTS.tags;
      }
      if (hasSkill(descNorm, skillNorm)) {
        fields.push('description');
        skillScore += MATCH_FIELD_WEIGHTS.description;
        fieldScores.description += MATCH_FIELD_WEIGHTS.description;
      }
      if (skillScore > 0) skillHits.push({ skill, score: skillScore, fields });
    }

    const score = fieldScores.title + fieldScores.tags + fieldScores.description;
    if (score > 0) {
      matches.push({
        posting,
        score,
        matchedSkills: skillHits.map((h) => h.skill),
        fieldScores,
        skillHits,
      });
    }
  }

  // 相关度降序；平分时新发布在前（ISO 字符串可直接比较）
  matches.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return b.posting.postedAt.localeCompare(a.posting.postedAt);
  });

  return criteria.limit !== undefined ? matches.slice(0, criteria.limit) : matches;
}
