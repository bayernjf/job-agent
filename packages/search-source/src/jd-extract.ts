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
  // T1-1：先过滤"非岗位详情页"（聚合列表、组织架构页、社交频道、数据站等），
  // 避免 Tavily 结果里的导航页被误当岗位入库。
  if (!looksLikeJobPosting(item)) return null;

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

/**
 * 岗位可信度过滤（T1-1，真实端到端发现的误报问题）：
 * Tavily 对中文岗位的结果常含聚合列表页、组织架构页、社交频道，这些不是岗位详情页，
 * 必须在抽取前丢弃。规则刻意保守（宁丢勿编），海外真实 ATS 详情页不受影响。
 */

/** host 硬黑名单：数据/社交/通讯/百科类站点，命中即不可能是岗位详情页。 */
const URL_HOST_BLOCKLIST = [
  't.me', 'twitter.com', 'x.com', 'facebook.com', 'weibo.com', 'instagram.com',
  'rocketreach.co', 'crunchbase.com', 'zoominfo.com', 'bloomberg.com', 'signalhire.com',
  'wikipedia.org', 'youtube.com', 'github.com', 'reddit.com',
  // 课程/内容平台（无岗位详情页）
  'coursera.org', 'udemy.com', 'edx.org', 'pluralsight.com', 'medium.com',
];

/** 标题中的列表/导航/公司介绍特征。 */
const TITLE_BLOCK_PATTERNS: ReadonlyArray<RegExp> = [
  /招聘网|招聘信息|招聘大全|最新.*招聘|招聘信息汇总/,
  /management team|org chart|leadership team|company profile|about us|employees/i,
  /telegram|频道|群组|whatsapp group/i,
  // 求职者本人发的求职帖（不是招聘岗位）
  /找一份|找工作|求职|应聘|seeking (a )?job|looking for (a )?job|available for hire/i,
  // SEO 聚合/搜索页标题（Indeed/DevJobsScanner 等）
  /now hiring[:\s]*[\d,]/i,
  /[\d,]+\+?\s+[a-z &]*jobs?\b/i, // "8,000 Ai Agent Developer Jobs"
  /jobs?\s*[–-]\s*apply today/i,
  /latest .*job openings|browse .*jobs|all .*jobs/i,
  /[\w &]*jobs?\s*[–-]\s*[\w &]*jobs?/i, // "Miami Jobs - Tech & Startup Jobs"
  // 教程/科普/课程标题（不是岗位）
  /what is|what are|how to become|a guide to|introduction to|online course|certification|tutorial|learn .*online/i,
  /meet the|day in the life|role of the/i, // 公司博客的岗位介绍文
];

/** 标题中的职位词（命中即视为"像岗位标题"）。 */
const JOB_TITLE_WORDS =
  /工程师|开发|设计师|产品经理|架构师|运维|测试|经理|主管|engineer|developer|designer|manager|architect|programmer|scientist|analyst|consultant|administrator|devops|sre/i;

/** 正文中的 JD 信号（职责/要求/经验类措辞，中英文）。 */
const JD_SIGNAL_PATTERNS: ReadonlyArray<RegExp> = [
  /职责|任职要求|岗位要求|招聘要求|职位描述/,
  /responsibilit|requirements?|qualifications|we'?re looking|you have|years of experience|experience with|what you'?ll do/i,
];

/** 技能提示词（同时供 extractTags 使用，定义提前）。 */
const SKILL_HINTS = [
  'react', 'vue', 'angular', 'node', 'typescript', 'javascript', 'python', 'java', 'go',
  'rust', 'kotlin', 'swift', 'ai', 'llm', 'machine learning', 'aws', 'gcp', 'azure',
  'docker', 'kubernetes', 'postgres', 'mysql', 'graphql', 'redis', 'terraform',
];

/** 列表/首页 URL 判定：路径为站点/板块根、搜索页、Greenhouse board 等。 */
function isListingUrl(rawUrl: string, u: URL): boolean {
  const p = u.pathname.replace(/\/$/, '');
  if (p === '' || p === '/jobs' || p === '/careers' || p === '/en/jobs' || p === '/zh/jobs') {
    return true;
  }
  if (/\/(jobs|careers|zhaopin)\/search/i.test(p)) return true;
  if (/job_board/i.test(u.search)) return true; // Greenhouse 列表页（详情页路径为 /jobs/NNN）
  return false;
}

/** 判定搜索结果项是否像一个岗位详情页；纯函数。 */
export function looksLikeJobPosting(item: SearchResultItem): boolean {
  let u: URL;
  try {
    u = new URL(item.url);
  } catch {
    return false;
  }
  const host = u.hostname.replace(/^www\./, '');
  if (URL_HOST_BLOCKLIST.some((b) => host === b || host.endsWith(`.${b}`))) return false;
  if (isListingUrl(item.url, u)) return false;
  if (TITLE_BLOCK_PATTERNS.some((pat) => pat.test(item.title ?? ''))) return false;

  const content = (item.content ?? '').trim();
  const titleHasJobWord = JOB_TITLE_WORDS.test(item.title ?? '');
  if (content.length < 60) return titleHasJobWord; // 正文太短时只信职位标题

  const hasJdSignal = JD_SIGNAL_PATTERNS.some((pat) => pat.test(content));
  const lower = content.toLowerCase();
  // 只数"硬技术"（编程语言/框架/工具）；ai/llm/aws 等泛词在科普文里太常见，不计入
  const softSkills = new Set(['ai', 'llm', 'machine learning', 'aws', 'gcp', 'azure']);
  const skillHits = SKILL_HINTS.filter(
    (s) => !softSkills.has(s) && new RegExp(`\\b${s}\\b`, 'i').test(lower),
  ).length;
  // 标题是职位词，或正文含 JD 措辞，或正文命中 ≥2 个硬技术 → 像岗位
  return titleHasJobWord || hasJdSignal || skillHits >= 2;
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
