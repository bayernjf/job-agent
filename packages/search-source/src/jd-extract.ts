/**
 * JD 结构化抽取（design-websearch-job-discovery §2 步骤④ / §6 LLM 角色）。
 *
 * P0 用确定性启发式：从 Tavily search 返回的 title + content + url 抽取
 * title/company/location/remote/salary/tags/description，产出可入库的岗位候选。
 * LLM 抽取作为增强留给 P1（本文件保留纯函数形态，后续可加 `llm` 注入分支）。
 *
 * 失败策略：无法抽到合法 title/company 的候选返回 null（丢弃并记因），
 * 绝不编造字段——延续"无证据不下结论"的产品不变量。
 */
import type { SearchConditions } from '@jobagent/shared';
import type { SearchResultItem } from './types.js';

export interface ExtractedJob {
  title: string;
  company: string;
  location: string | null;
  remote: boolean;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
  tags: string[];
  description: string | null;
  /** 站名（来源域名，供 UI 徽标） */
  site: string | null;
}

/** 从搜索结果项抽取岗位（启发式）；抽不出关键字段返回 null。 */
export function extractJobFromSearchResult(
  item: SearchResultItem,
  conditions: SearchConditions,
): ExtractedJob | null {
  const title = cleanTitle(item.title);
  if (!title) return null;

  const blob = `${item.title} ${item.content}`.replace(/\s+/g, ' ').slice(0, 4000);
  const company = extractCompany(item, blob);
  if (!company) return null;

  const remote = conditions.remote || /remote|anywhere|work from home|远程|居家/i.test(blob);
  const location = conditions.location ?? extractLocation(blob);
  const { salaryMin, salaryMax, salaryCurrency } = extractSalary(blob);
  const tags = extractTags(blob, conditions.keywords);
  const description = item.content.trim().slice(0, 800) || null;
  const site = extractSite(item.url);

  return {
    title,
    company,
    location,
    remote,
    salaryMin,
    salaryMax,
    salaryCurrency,
    tags,
    description,
    site,
  };
}

/** 标题清洗：去掉站点后缀（" - LinkedIn"、" | Indeed" 等） */
function cleanTitle(raw: string): string | null {
  const t = raw
    .replace(/[|\-–—]\s*(linkedin|indeed|glassdoor|jobs|careers|remote|lever|greenhouse)\s*$/i, '')
    .trim();
  return t.length > 0 && t.length <= 200 ? t : null;
}

/** 公司提取：title "X at Y" → Y；否则 content "at Y" / "Y is hiring"；否则取域名。 */
function extractCompany(item: SearchResultItem, blob: string): string | null {
  const atMatch = item.title.match(/\bat\s+([A-Z][\w&.' -]{1,40}?)(?:\s*[|–-]|\s*$)/i);
  if (atMatch?.[1]) {
    const c = atMatch[1].trim();
    if (c.length >= 2) return c;
  }
  const hiringMatch = item.content.match(/(?:^|[.。])\s*([A-Z][\w&.' -]{2,40}?)\s+is\s+hiring/i);
  if (hiringMatch?.[1]) {
    const c = hiringMatch[1].trim();
    if (c.length >= 2) return c;
  }
  const atMatch2 = blob.match(/\bat\s+([A-Z][\w&.' -]{2,40}?)(?:\s+[.-]|\s*$)/i);
  if (atMatch2?.[1]) {
    const c = atMatch2[1].trim();
    if (c.length >= 2) return c;
  }
  // 域名兜底：jobs.acme.io / careers.acme.com 等招聘子域
  try {
    const host = new URL(item.url).hostname.replace(/^www\./, '');
    if (host && host.length <= 80) return host;
  } catch {
    // 非法 URL 由 buildPosting 拦截，此处兜底失败即丢弃
  }
  return null;
}

const LOCATION_WORDS = [
  'Shenzhen', 'Beijing', 'Shanghai', 'Guangzhou', 'Hangzhou', 'Chengdu', 'Singapore',
  'New York', 'San Francisco', 'London', 'Berlin', 'Tokyo', 'Remote',
];
function extractLocation(blob: string): string | null {
  for (const loc of LOCATION_WORDS) {
    if (new RegExp(`\\b${loc}\\b`, 'i').test(blob)) return loc;
  }
  // 中文城市
  for (const city of ['深圳', '北京', '上海', '广州', '杭州', '成都', '南京', '武汉', '苏州']) {
    if (blob.includes(city)) return city;
  }
  return null;
}

const SALARY_PATTERNS: ReadonlyArray<RegExp> = [
  /\$\s*(\d{2,3})\s*k\s*[-–~]\s*\$?\s*(\d{2,3})\s*k/i,
  /\$\s*(\d{2,3})\s*k\b/i,
  /\$\s*(\d{1,3}(?:,\d{3})*)\s*[-–~]\s*\$?\s*(\d{1,3}(?:,\d{3})*)\b/i,
  /\$\s*(\d{1,3}(?:,\d{3})*)\b/i,
];
function extractSalary(blob: string): {
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
} {
  for (const pattern of SALARY_PATTERNS) {
    const m = blob.match(pattern);
    if (!m) continue;
    const toUsd = (s: string): number => {
      const n = Number(s.replace(/,/g, ''));
      return m[0].includes('k') ? n * 1000 : n;
    };
    if (m[2] !== undefined) {
      return {
        salaryMin: toUsd(m[1] ?? ''),
        salaryMax: toUsd(m[2]),
        salaryCurrency: 'USD',
      };
    }
    return { salaryMin: toUsd(m[1] ?? ''), salaryMax: null, salaryCurrency: 'USD' };
  }
  return { salaryMin: null, salaryMax: null, salaryCurrency: null };
}

/** 标签：用户条件关键词中命中 JD 文本者 + 少量硬编码技能提示词 */
const SKILL_HINTS = [
  'react', 'vue', 'angular', 'node', 'typescript', 'javascript', 'python', 'java', 'go',
  'rust', 'kotlin', 'swift', 'ai', 'llm', 'machine learning', 'aws', 'gcp', 'azure',
  'docker', 'kubernetes', 'postgres', 'mysql', 'graphql', 'redis', 'terraform',
];
function extractTags(blob: string, userKeywords: string[]): string[] {
  const tags = new Set<string>();
  const lower = blob.toLowerCase();
  for (const kw of userKeywords) {
    if (kw.length >= 2 && lower.includes(kw.toLowerCase())) tags.add(kw);
  }
  for (const skill of SKILL_HINTS) {
    if (new RegExp(`\\b${skill.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(lower)) {
      tags.add(skill);
    }
  }
  return [...tags].slice(0, 12);
}

function extractSite(url: string): string | null {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    return host || null;
  } catch {
    return null;
  }
}
