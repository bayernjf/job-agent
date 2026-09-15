/**
 * resume-core 类型定义（岗位定向简历，纯函数、零 I/O）。
 * 设计见 docs/design-targeted-resume-20260915.md。
 */
import type {
  AbilityProfile,
  EvidenceItem,
  JobPosting,
  LocalResumeFields,
  ResumeLocale,
} from '@jobagent/shared';

/** 岗位字段（匹配命中位置），与 job-source 的 MatchField 同值，本包不反向依赖采集包 */
export type ResumeMatchField = 'title' | 'tags' | 'description';

/**
 * 匹配结果输入（结构同 @jobagent/job-source 的 JobMatch 中打分部分）。
 * 调用方先用 matchJobs 算好传入，本内核不重复匹配、不依赖 job-source。
 */
export interface ResumeMatchInput {
  /** 加权相关度分 */
  score: number;
  /** 命中的画像技能名（原始写法） */
  matchedSkills: string[];
  fieldScores: { title: number; tags: number; description: number };
  /** 逐技能命中明细（用于命中技能内部排序） */
  skillHits: Array<{ skill: string; score: number; fields: ResumeMatchField[] }>;
}

export interface BuildResumeOptions {
  /** evidenceHighlights 条数上限，默认 10 */
  highlightLimit?: number;
  /** 模板语言（技能名等事实保持画像原文不翻译），默认 zh-CN */
  locale?: ResumeLocale;
  /** 注入生成时间（测试确定性）；默认 new Date().toISOString() */
  now?: string;
}

export interface BuildResumeInput {
  profile: AbilityProfile;
  /** profile 证据全集（由 storage.listByProfile 或离线 JSON 提供）；内核按 evidenceRefs 反查 */
  evidence: EvidenceItem[];
  posting: JobPosting;
  match: ResumeMatchInput;
  /** 用户本地补填（教育/工作经历/联系方式）；画像不提供，缺失则显式占位，绝不臆造 */
  local?: LocalResumeFields;
  options?: BuildResumeOptions;
}

export const DEFAULT_HIGHLIGHT_LIMIT = 10;
