import { createHash } from 'node:crypto';

/**
 * 跨源去重键与 URL 规范化。
 * - canonicalizeUrl 剥离 utm_ 前缀与 ref 等跟踪参数及 fragment，稳定同源 URL；
 * - makeNormalizedKey 对 (标题, 公司, 地点) 归一后取 sha1，用于「疑似同岗」标记，
 *   跨源只标记不自动合并（设计决策）。
 */

const TRACKING_PREFIXES = ['utm_'];
const TRACKING_KEYS = new Set([
  'ref',
  'ref_src',
  'fbclid',
  'gclid',
  'igshid',
  'spm',
  'source',
  'mc_cid',
  'mc_eid',
]);

export function canonicalizeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    // 去掉非根路径的末尾斜杠（须在拼 query 之前处理 pathname）
    if (u.pathname.length > 1 && u.pathname.endsWith('/')) {
      u.pathname = u.pathname.slice(0, -1);
    }
    const kept = [...u.searchParams.entries()]
      .filter(([k]) => {
        const key = k.toLowerCase();
        return (
          !TRACKING_PREFIXES.some((p) => key.startsWith(p)) && !TRACKING_KEYS.has(key)
        );
      })
      .sort(([a], [b]) => a.localeCompare(b));
    u.search = '';
    u.hash = '';
    for (const [k, v] of kept) u.searchParams.append(k, v);
    return u.toString();
  } catch {
    return raw;
  }
}

/** 小写、去标点、压缩空白（保留字母数字与空格）。 */
export function normalizeSegment(input: unknown): string {
  return String(input ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const COMPANY_SUFFIX = /\b(inc|incorporated|llc|ltd|limited|corp|corporation|co|gmbh|company)\b\.?$/;

/** 反复剥离公司类型后缀（Inc/Ltd/LLC…）直到稳定。 */
export function normalizeCompanyName(input: unknown): string {
  let s = normalizeSegment(input);
  let prev: string;
  do {
    prev = s;
    s = s.replace(COMPANY_SUFFIX, '').trim();
  } while (s !== prev && s.length > 0);
  return s;
}

export function makeNormalizedKey(title: unknown, company: unknown, location: unknown): string {
  const parts = [
    normalizeSegment(title),
    normalizeCompanyName(company),
    normalizeSegment(location),
  ].join('|');
  return createHash('sha1').update(parts).digest('hex');
}
