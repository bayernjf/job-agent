/**
 * 能力画像 ↔ 岗位匹配（P2-D 消费侧，纯函数、无 I/O）。
 *
 * 输入一批已检索出的岗位 + 画像技能名（analyzer-core 产出的 skillTags.name），
 * 在岗位 title / tags / description 上做可解释的加权命中打分，输出按相关度
 * 排序的结果，每条带命中的技能清单，便于报告页解释「为什么推荐这个岗位」。
 *
 * 保守原则：
 *   - 至少命中一个技能才返回（score>0），不做语义近似/向量召回；
 *   - 词边界匹配，归一化小写、去标点，避免 "java" 误命中 "javascript"；
 *   - remote / 薪资 / 源为硬过滤，打分只负责相关度排序。
 * 该模块不依赖数据库与网络，可对固定输入做单测。
 */
import type { JobPosting, JobSource } from '@jobagent/shared';
import { normalizeSegment } from '../normalize/dedupe-key.js';

/** 字段命中权重：标题最能代表岗位，标签次之，正文兜底。 */
const TITLE_WEIGHT = 3;
const TAG_WEIGHT = 2;
const DESCRIPTION_WEIGHT = 1;

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

export interface JobMatch<T extends JobPosting = JobPosting> {
  posting: T;
  /** 加权相关度分（越高越相关） */
  score: number;
  /** 命中的画像技能（原始写法，去重，按首次命中顺序） */
  matchedSkills: string[];
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

    let score = 0;
    const matched: string[] = [];
    for (const skill of skills) {
      const skillNorm = normalizeSegment(skill);
      let fieldScore = 0;
      if (hasSkill(titleNorm, skillNorm)) fieldScore += TITLE_WEIGHT;
      if (hasSkill(tagsNorm, skillNorm)) fieldScore += TAG_WEIGHT;
      if (hasSkill(descNorm, skillNorm)) fieldScore += DESCRIPTION_WEIGHT;
      if (fieldScore > 0) {
        score += fieldScore;
        if (!matched.includes(skill)) matched.push(skill);
      }
    }

    if (score > 0) matches.push({ posting, score, matchedSkills: matched });
  }

  // 相关度降序；平分时新发布在前（ISO 字符串可直接比较）
  matches.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return b.posting.postedAt.localeCompare(a.posting.postedAt);
  });

  return criteria.limit !== undefined ? matches.slice(0, criteria.limit) : matches;
}
