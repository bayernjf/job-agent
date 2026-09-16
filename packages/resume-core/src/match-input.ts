/**
 * 把 @jobagent/job-source 的 JobMatch 打分子集映射为简历内核所需的 ResumeMatchInput。
 *
 * resume-core 刻意不反向依赖 job-source（设计 §2.1：内核零 I/O、不依赖采集包），
 * 故这里用结构化鸭子类型接收 JobMatch 的同形字段，CLI 与 API 共用本映射，
 * 避免在两个 I/O 薄封装里重复 ZERO_MATCH 与字段搬运逻辑。
 */
import type { ResumeMatchField, ResumeMatchInput } from './types.js';

const zeroFieldScores = (): { title: number; tags: number; description: number } => ({
  title: 0,
  tags: 0,
  description: 0,
});

/** 零匹配（岗位零命中时走 low_match 降级）。每次取一份新 fieldScores，避免共享引用被改。 */
export function zeroResumeMatch(): ResumeMatchInput {
  return { score: 0, matchedSkills: [], fieldScores: zeroFieldScores(), skillHits: [] };
}

/** job-source JobMatch 的同形子集（仅打分部分，posting 由调用方另行传入）。 */
export interface JobMatchLike {
  score: number;
  matchedSkills: string[];
  fieldScores?: { title: number; tags: number; description: number };
  skillHits?: Array<{ skill: string; score: number; fields: ResumeMatchField[] }>;
}

/**
 * JobMatch（或 null/undefined，零命中）→ ResumeMatchInput。
 * 缺省的 fieldScores/skillHits 补零，保证下游 buildResume 永不读到 undefined。
 */
export function fromJobMatch(match: JobMatchLike | null | undefined): ResumeMatchInput {
  if (!match) return zeroResumeMatch();
  return {
    score: typeof match.score === 'number' && Number.isFinite(match.score) ? match.score : 0,
    matchedSkills: Array.isArray(match.matchedSkills) ? match.matchedSkills : [],
    fieldScores: { ...zeroFieldScores(), ...(match.fieldScores ?? {}) },
    skillHits: Array.isArray(match.skillHits)
      ? match.skillHits.map((h) => ({ skill: h.skill, score: h.score, fields: h.fields }))
      : [],
  };
}
