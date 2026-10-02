import {
  JobSourceSchema,
  type JobPreferences,
  type JobSource,
  type MatchScoreTier,
} from '@jobagent/shared';

/**
 * 求职偏好 → 岗位筛选/打分输入（设计 §3.1）。
 *
 * 这一层只做「拿偏好筛岗位池」，不复制 matchJobs 的打分公式：
 * 加权命中（title×3 + tags×2 + description×1）仍由 packages/job-source 的 matchJobs 负责，
 * 这里产出它需要的 criteria（`preferenceToMatchCriteria`），并把 matchJobs 表达不了的
 * 偏好（多个目标岗位关键词、地区、公司黑白名单）在自己这层用可预测的规则先筛一遍。
 *
 * 无 I/O、无方言、无 storage 依赖：刻意不 import job-source（那会把 storage 依赖拖进纯内核），
 * 归一化规则与 job-source 的 normalizeSegment 同口径，并由测试钉住同口径样例。
 */

/**
 * 文本归一化：小写、非字母数字转空格、压缩空白。
 * 与 `packages/job-source/src/normalize/dedupe-key.ts` 的 normalizeSegment 同一套规则
 * （改这里等于改命中口径，测试 preference.test.ts 会钉住边界样例）。
 */
export function normalizeText(input: unknown): string {
  return String(input ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 内核只依赖岗位的结构形状（不 import storage 的 StoredJobPosting）。 */
export interface PreferencePostingLike {
  /** 岗位池主键 `job_postings.id`（派生值）；采集结果一定有，离线夹具可省略 */
  id?: string;
  jobId: string;
  source: JobSource;
  title: string;
  company: string;
  location?: string | null;
  remote: boolean;
  salaryMin?: number | null;
  salaryMax?: number | null;
  tags?: readonly string[];
  description?: string | null;
  postedAt: string;
}

/** 与 job-source `JobMatchCriteria` 同形（结构性兼容，无需类型断言）。 */
export interface MatchCriteriaLike {
  skills: string[];
  remote?: boolean;
  salaryMinUsd?: number;
  sources?: readonly JobSource[];
  limit?: number;
}

/** 参与打分的技能：偏好显式给的优先，留空则退回画像技能名（画像为空则无候选）。 */
export function preferenceSkills(
  pref: Pick<JobPreferences, 'skills'>,
  profileSkills: readonly string[],
): string[] {
  const own = pref.skills.map((s) => s.trim()).filter((s) => s.length > 0);
  return own.length > 0 ? own : profileSkills.map((s) => s.trim()).filter((s) => s.length > 0);
}

/** 合法的岗位来源（取自 shared 的 Zod 枚举，避免第三处手抄）。 */
const KNOWN_SOURCES: ReadonlySet<string> = new Set(JobSourceSchema.options);

/** 把落库的 sources（TEXT 里可能存着任何历史字符串）收敛成已知来源，未知值直接丢弃。 */
export function knownSources(sources: readonly string[]): JobSource[] {
  return sources.filter((source): source is JobSource => KNOWN_SOURCES.has(source));
}

/** 把偏好投影成 matchJobs 的 criteria（硬过滤口径与 matchJobs 完全一致）。 */
export function preferenceToMatchCriteria(
  pref: Pick<JobPreferences, 'skills' | 'remoteOnly' | 'salaryMinUsd'> & { sources: readonly string[] },
  profileSkills: readonly string[],
): MatchCriteriaLike {
  const criteria: MatchCriteriaLike = { skills: preferenceSkills(pref, profileSkills) };
  if (pref.remoteOnly) criteria.remote = true;
  if (typeof pref.salaryMinUsd === 'number') criteria.salaryMinUsd = pref.salaryMinUsd;
  const sources = knownSources(pref.sources);
  if (sources.length > 0) criteria.sources = sources;
  return criteria;
}

/** 岗位可被偏好关键词命中的文本（标题 + 标签 + 正文）。 */
function postingHaystack(posting: PreferencePostingLike): string {
  return normalizeText([posting.title, (posting.tags ?? []).join(' '), posting.description ?? ''].join(' '));
}

function anyTermMatches(haystack: string, terms: readonly string[]): boolean {
  return terms.some((term) => {
    const t = normalizeText(term);
    return t.length > 0 && haystack.includes(t);
  });
}

function companyMatches(company: string, terms: readonly string[]): boolean {
  const c = normalizeText(company);
  return terms.some((term) => {
    const t = normalizeText(term);
    return t.length > 0 && c.includes(t);
  });
}

/**
 * 用偏好做硬过滤（在 matchJobs 之前跑，宁少勿滥）：
 * - `targetTitles`：任一关键词命中 title/tags/description 才保留（偏好至少一个关键词，契约已保证）；
 * - `locations`：非远程岗位要求 location 原文命中任一地区词；`remoteOnly` 时不看地区（远程岗地区字段无意义）；
 * - `companyBlacklist`：命中即剔除；`companyWhitelist` 不做排除，只用于排序优先。
 */
export function filterPostingsForPreference<T extends PreferencePostingLike>(
  postings: readonly T[],
  pref: Pick<JobPreferences, 'targetTitles' | 'locations' | 'remoteOnly' | 'companyWhitelist' | 'companyBlacklist'>,
): T[] {
  const titles = pref.targetTitles;
  const locations = pref.locations;
  return postings.filter((posting) => {
    if (companyMatches(posting.company, pref.companyBlacklist)) return false;
    if (!anyTermMatches(postingHaystack(posting), titles)) return false;
    if (!pref.remoteOnly && locations.length > 0) {
      const loc = normalizeText(posting.location ?? '');
      if (!anyTermMatches(loc, locations)) return false;
    }
    return true;
  });
}

/** 白名单公司优先（岗位池里的公司名做包含匹配，宽松优先、绝不因此丢岗位）。 */
export function isPreferredCompany(
  company: string,
  pref: Pick<JobPreferences, 'companyWhitelist'>,
): boolean {
  return pref.companyWhitelist.length > 0 && companyMatches(company, pref.companyWhitelist);
}

/** 档位排序（low < mid < high），用于质量闸与展示排序。 */
export const TIER_ORDER: Readonly<Record<MatchScoreTier, number>> = { low: 0, mid: 1, high: 2 };

/** 质量闸：低于偏好设定的最低档不进待投清单（设计 §4.3 防海投）。 */
export function passesQualityGate(tier: MatchScoreTier, minTier: MatchScoreTier): boolean {
  return TIER_ORDER[tier] >= TIER_ORDER[minTier];
}
