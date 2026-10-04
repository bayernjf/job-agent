/**
 * 阶段 2 A2：把后端返回的待填充票据（approved SubmitIntent）按当前 ATS 页面 URL 匹配。
 * 纯函数、无 DOM/网络依赖，便于单测。
 *
 * 匹配口径（宽松但要求同 host）：Greenhouse/Lever 的申请表单 URL 常是岗位页加 /apply
 * （如 boards.greenhouse.io/acme/jobs/123 → .../jobs/123/apply），故 path 做"相等或互为
 * 前缀段"判定，query/hash 一律忽略。host 必须一致（忽略 leading www. 与大小写）。
 */

import type { PendingFill } from '../lib/api.js';

export type { PendingFill };

function normHost(host: string): string {
  return host.toLowerCase().replace(/^www\./, '');
}

/** 规范化 path：小写、去尾斜杠、折叠重复斜杠。 */
function normPath(pathname: string): string {
  return `/${pathname}`.replace(/\/{2,}/g, '/').replace(/\/+$/, '').toLowerCase();
}

/** 两个 path 是否相等或互为完整路径段前缀（/jobs/1 匹配 /jobs/1/apply，不匹配 /jobs/10）。 */
function pathMatches(a: string, b: string): boolean {
  const x = normPath(a);
  const y = normPath(b);
  if (x === y) return true;
  const longer = x.length > y.length ? x : y;
  const shorter = x.length > y.length ? y : x;
  return longer.startsWith(`${shorter}/`);
}

/** 单个候选 URL（sourceUrl/applyUrl）是否与当前页面 URL 同 host 且 path 命中。 */
export function urlMatchesPage(candidate: string, pageUrl: string): boolean {
  let cand: URL;
  let page: URL;
  try {
    cand = new URL(candidate);
    page = new URL(pageUrl);
  } catch {
    return false;
  }
  if (normHost(cand.host) !== normHost(page.host)) return false;
  return pathMatches(cand.pathname, page.pathname);
}

/**
 * 返回与当前页面匹配的待填充票据（按后端给定顺序，通常已 approvedAt 倒序）。
 * 任一 job.sourceUrl / job.applyUrl 命中即算匹配。
 */
export function matchFillsToPage(fills: readonly PendingFill[], pageUrl: string): PendingFill[] {
  return fills.filter((fill) => {
    const candidates = [fill.job.sourceUrl, fill.job.applyUrl].filter(
      (u): u is string => typeof u === 'string' && u.length > 0,
    );
    return candidates.some((u) => urlMatchesPage(u, pageUrl));
  });
}
