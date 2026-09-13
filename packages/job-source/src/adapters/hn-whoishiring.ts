/**
 * HN「Ask HN: Who is hiring?」月度自由文本采集适配器（P2-C）。
 *
 * HN 没有结构化岗位 API：每月 1 号 whoishiring 发一个父帖，雇主在顶层评论里
 * 用约定的 `Company | Role | Location | Job type | Salary | Link` 自由文本跟帖，
 * 字段顺序/段数不固定，正文是 HTML。这里走 Algolia 两阶段：
 *   1. search_by_date 找到最新月度 hiring 父帖（排除「Who wants to be hired」求职帖）；
 *   2. items 拉父帖评论树，对每条顶层评论做保守规则解析。
 *
 * 保守原则（设计 §6.6）：
 *   - header（第一个 <p> 之前）按 `|` 分段，少于 3 段（company|role|至少一个其他字段）
 *     视为置信度不足整条跳过并计入 invalid，宁可漏不可错；
 *   - 只解析顶层评论（雇主岗位），不递归子评论（多为讨论/提问）；
 *   - 非美元薪资只留币种、数值置 null（复用 parseSalaryText）；
 *   - sourceUrl 用评论永久链接，便于人工复核。
 *
 * 该源是月度源：默认日更适配器集合不含它，仅在显式 sources 含 hn_whoishiring
 * 时挂载，每月单独跑一次（设计 §7.3）。
 */
import type { JobSource } from '@jobagent/shared';
import { buildPosting, type RawPostingCandidate } from './builder.js';
import type { CollectContext, CollectResult, JobSourceAdapter } from './types.js';
import { collapseWhitespace, decodeEntities, stripHtml } from '../normalize/html.js';
import { parseSalaryText } from '../normalize/salary.js';
import { inferRemote } from '../normalize/remote.js';
import { canonicalizeUrl } from '../normalize/dedupe-key.js';
import { textToIso } from '../normalize/date.js';

const SEARCH_ENDPOINT =
  'https://hn.algolia.com/api/v1/search_by_date?tags=story,author_whoishiring&hitsPerPage=8';
const itemEndpoint = (storyId: string): string =>
  `https://hn.algolia.com/api/v1/items/${storyId}`;
const permalink = (commentId: number | string): string =>
  `https://news.ycombinator.com/item?id=${commentId}`;

/** header 最少段数：company | role | 至少一个其他字段（地点/类型/薪资/链接）。 */
const MIN_SEGMENTS = 3;

const HIRING_TITLE = /who\s+is\s+hiring\b/i;
const SEEKER_TITLE = /wants\s+to\s+be\s+hired/i;

/** 薪资段必须带货币符号/单位/千位，避免把「10–40 hrs/wk」这类数字误判成薪资。 */
const SALARY_HINT = /[$€£¥]|salary|compensation|\b\d{2,3}\s*k\b|\d{1,3},\d{3}/i;
const JOB_TYPE_RULES: Array<[RegExp, string]> = [
  [/full[\s-]?time/i, 'full-time'],
  [/part[\s-]?time/i, 'part-time'],
  [/\bcontract/i, 'contract'],
  [/\bintern/i, 'internship'],
  [/\bfreelance/i, 'freelance'],
  [/\bpermanent/i, 'permanent'],
  [/\btemporary/i, 'temporary'],
];
const ANCHOR_RE = /<a\b[^>]*>[\s\S]*?<\/a>/gi;
const FIRST_HREF_RE = /<a\b[^>]*?\bhref\s*=\s*["']([^"']+)["'][^>]*>/i;
const FIRST_PARA_RE = /<p[\s>]/i;

interface HnSearchHit {
  objectID?: unknown;
  title?: unknown;
}
interface HnComment {
  id?: unknown;
  author?: unknown;
  created_at?: unknown;
  text?: unknown;
}
interface HnThread {
  children?: unknown;
}

/**
 * 从 search_by_date 响应里选出最新月度 hiring 父帖 id。
 * 响应已按时间倒序，取第一个标题是「Who is hiring?」且不是求职帖的 hit。
 * 导出为纯函数便于单测。
 */
export function pickHiringStoryId(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return null;
  const hits = (raw as { hits?: unknown }).hits;
  if (!Array.isArray(hits)) return null;
  for (const hit of hits as HnSearchHit[]) {
    const title = typeof hit?.title === 'string' ? hit.title : '';
    if (HIRING_TITLE.test(title) && !SEEKER_TITLE.test(title)) {
      return typeof hit.objectID === 'string' && hit.objectID.length > 0 ? hit.objectID : null;
    }
  }
  return null;
}

/** 提取 HTML 中第一个锚点 href（HN 把 href 也做了实体编码，需解码 + 规范化）。 */
function extractFirstHref(html: string): string | null {
  const m = FIRST_HREF_RE.exec(html);
  if (!m || !m[1]) return null;
  const decoded = decodeEntities(m[1]);
  if (!/^https?:\/\//i.test(decoded)) return null;
  const canon = canonicalizeUrl(decoded);
  try {
    // eslint-disable-next-line no-new
    new URL(canon);
    return canon;
  } catch {
    return null;
  }
}

/** 移除锚点（含锚文本），用于公司段，避免链接文本污染公司名。 */
function removeAnchors(html: string): string {
  return html.replace(ANCHOR_RE, ' ');
}

/** 把评论切成 header（字段行）与 body（正文 HTML）。 */
function splitHeaderBody(text: string): [string, string] {
  const m = FIRST_PARA_RE.exec(text);
  if (!m || m.index === undefined) return [text, ''];
  return [text.slice(0, m.index), text.slice(m.index)];
}

/** 从一个段提取归一化的雇佣类型标签（去重由调用方处理）。 */
function extractJobTypes(segmentText: string): string[] {
  const out: string[] = [];
  for (const [re, label] of JOB_TYPE_RULES) {
    if (re.test(segmentText) && !out.includes(label)) out.push(label);
  }
  return out;
}

/** 从地点段剥离 remote/hybrid/onsite 标记与括号，得到纯地点；无残留返回 null。 */
function cleanLocation(segmentHtml: string): string | null {
  let s = collapseWhitespace(stripHtml(removeAnchors(segmentHtml)) ?? '');
  s = s.replace(/[()]/g, ' ');
  s = s.replace(/\b(?:remote|hybrid|on-?site)\b/gi, ' ');
  s = collapseWhitespace(s).replace(/^[\s,;:/|-]+|[\s,;:/|-]+$/g, '');
  return s.length > 0 ? s : null;
}

/** 公司段：移除内嵌锚（连同文本）后，清掉空括号残留（如 `Acme (<a>…</a>)` → Acme）。 */
function cleanCompanySegment(segmentHtml: string): string {
  let s = stripHtml(removeAnchors(segmentHtml)) ?? '';
  s = s.replace(/\(\s*\)/g, ' ').replace(/\[\s*]/g, ' ');
  s = collapseWhitespace(s).replace(/^[\s()[\]]+|[\s()[\]]+$/g, '');
  return s;
}

function uniquePush(list: string[], values: string[]): void {
  for (const v of values) if (!list.includes(v)) list.push(v);
}

/**
 * 补全薪资区间共享单位：HN 常写「$150 - 210K」（首个数省略 K）。
 * 规整为「$150K - 210K」再交给 parseSalaryText，避免被当成 150 美元。
 * 仅在「2-3 位数 - 2-3 位数 + 单个单位」时生效，已带单位的不受影响。
 */
function expandSharedUnit(text: string): string {
  return text.replace(
    /(\d{2,3}(?:\.\d+)?)(\s*(?:-|–|—|to)\s*)(\d{2,3}(?:\.\d+)?)(\s*)([kKmM])\b/g,
    (_match, first: string, gap: string, second: string, space: string, unit: string) =>
      `${first}${unit}${gap}${second}${space}${unit}`,
  );
}

/** 解析单条顶层评论；置信度不足/契约失败返回 null（调用方计入 invalid）。 */
function parseComment(comment: HnComment, fetchedAt: string): RawPostingCandidate | null {
  const rawText = typeof comment.text === 'string' ? comment.text : '';
  const commentId =
    typeof comment.id === 'number' ? String(comment.id) : typeof comment.id === 'string' ? comment.id : '';
  if (commentId.length === 0 || rawText.trim().length === 0) return null;

  const [headerRaw, bodyRaw] = splitHeaderBody(rawText);
  const segments = headerRaw.split('|').map((s) => s.trim());
  // 少于 company|role|其他字段 三段：自由格式或噪音，保守跳过
  if (segments.length < MIN_SEGMENTS) return null;

  const companySeg = segments[0];
  const titleSeg = segments[1];
  if (companySeg === undefined || titleSeg === undefined) return null;

  const company = cleanCompanySegment(companySeg);
  const title = collapseWhitespace(stripHtml(titleSeg) ?? '');
  if (company.length === 0 || title.length === 0) return null;

  let salaryMin: number | null = null;
  let salaryMax: number | null = null;
  let salaryCurrency: string | null = null;
  const tags: string[] = [];
  let location: string | null = null;
  const remoteEvidence: string[] = [];
  // 公司段也可能内嵌链接（如 `Snout <a href=...>`）
  let headerHref = extractFirstHref(companySeg) ?? extractFirstHref(titleSeg);

  for (const seg of segments.slice(2)) {
    if (seg === undefined) continue;
    const segHref = extractFirstHref(seg);
    if (segHref && !headerHref) headerHref = segHref;
    const plain = collapseWhitespace(stripHtml(seg) ?? '');
    const decoded = collapseWhitespace(decodeEntities(seg));

    // 纯链接段（去标签后为空或就是 URL）：只取链接，不当作地点/类型
    const isLinkOnly = plain.length === 0 || /^https?:\/\//i.test(plain);
    if (SALARY_HINT.test(decoded) && /\d/.test(decoded)) {
      const sal = parseSalaryText(expandSharedUnit(decoded));
      salaryMin = sal.min;
      salaryMax = sal.max;
      salaryCurrency = sal.currency;
      remoteEvidence.push(plain);
    } else if (extractJobTypes(decoded).length > 0) {
      uniquePush(tags, extractJobTypes(decoded));
      remoteEvidence.push(plain);
    } else if (!isLinkOnly) {
      if (location === null) location = cleanLocation(seg);
      remoteEvidence.push(plain);
    }
  }

  const remote = inferRemote(undefined, company, title, ...remoteEvidence);
  const applyUrl = headerHref ?? extractFirstHref(rawText);
  const description = stripHtml(bodyRaw);
  const postedAt = textToIso(comment.created_at) ?? fetchedAt;

  return {
    jobId: commentId,
    source: 'hn_whoishiring' satisfies JobSource,
    sourceUrl: permalink(commentId),
    title,
    company,
    ...(location ? { location } : {}),
    remote,
    ...(salaryMin !== null ? { salaryMin } : {}),
    ...(salaryMax !== null ? { salaryMax } : {}),
    ...(salaryCurrency ? { salaryCurrency } : {}),
    tags,
    ...(description ? { description } : {}),
    postedAt,
    fetchedAt,
    ...(applyUrl ? { applyUrl } : {}),
  };
}

/**
 * 解析 items 评论树为采集结果（纯函数，黄金路径单测入口）。
 * 只看顶层评论；低置信跳过与契约失败都计入 invalid。
 */
export function parseHnThread(raw: unknown, fetchedAt: string): CollectResult {
  const postings = [];
  let invalid = 0;
  const thread = (raw ?? {}) as HnThread;
  const children = Array.isArray(thread.children) ? (thread.children as HnComment[]) : [];
  for (const comment of children) {
    const candidate = parseComment(comment, fetchedAt);
    if (candidate === null) {
      invalid += 1;
      continue;
    }
    const built = buildPosting(candidate);
    if (built.ok) postings.push(built.posting);
    else invalid += 1;
  }
  return { postings, invalid };
}

export interface HnAdapterOptions {
  /** 指定月度父帖 id（测试/补指定月份用）；缺省时自动选最新 hiring 帖。 */
  storyId?: string;
}

/** HN 月度自由文本适配器。 */
export class HnWhoIsHiringAdapter implements JobSourceAdapter {
  readonly source: JobSource = 'hn_whoishiring';
  constructor(private readonly options: HnAdapterOptions = {}) {}

  async collect(ctx: CollectContext): Promise<CollectResult> {
    let storyId = this.options.storyId ?? null;
    if (storyId === null) {
      const search = await ctx.http.getJson<unknown>(SEARCH_ENDPOINT);
      storyId = pickHiringStoryId(search);
      if (storyId === null) {
        throw new Error('hn_whoishiring: no active "Ask HN: Who is hiring?" thread found');
      }
    }
    const thread = await ctx.http.getJson<unknown>(itemEndpoint(storyId));
    return parseHnThread(thread, ctx.fetchedAt);
  }
}
