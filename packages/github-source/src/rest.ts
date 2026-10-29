/**
 * REST 补充通道（技术选型 6.7：GraphQL 批量优先、REST 补）：
 * - user 公开 email（用于 commit author 一致性校验）；
 * - GraphQL 取 commit 失败时的 REST 回退；
 * - 极简 ETag 条件请求缓存（GraphQL 官方不支持 ETag，REST 层做）。
 */

import type { AnalyzerCommit, BehaviorEventSummary } from '@jobagent/shared';
import type { Octokit } from 'octokit';
import type { ProfileBadge } from './types.js';

export interface RestCommitRow {
  sha: string;
  commit: {
    message: string;
    author: { name: string | null; email: string | null; date: string } | null;
    committer: { date: string } | null;
  } | null;
}

export async function fetchRepoCommitsRest(
  octokit: Octokit,
  owner: string,
  repo: string,
  perPage = 30,
): Promise<RestCommitRow[]> {
  const res = await octokit.request('GET /repos/{owner}/{repo}/commits', {
    owner,
    repo,
    per_page: perPage,
  });
  return res.data as RestCommitRow[];
}

export function parseRestCommits(rows: RestCommitRow[], owner: string, repo: string): AnalyzerCommit[] {
  return rows
    .filter((r) => Boolean(r?.sha))
    .map((r) => ({
      oid: r.sha,
      committedAt: r.commit?.author?.date ?? r.commit?.committer?.date ?? '',
      authorName: r.commit?.author?.name ?? null,
      authorEmail: r.commit?.author?.email ?? null,
      repoName: `${owner}/${repo}`,
      messageHeadline: (r.commit?.message ?? '').split('\n')[0] ?? '',
    }));
}

/** GET /users/{username}/events/public 单条事件（只声明使用到的字段） */
export interface GitHubEventRow {
  type?: string | null;
  actor?: { login?: string | null } | null;
  repo?: { name?: string | null } | null; // GitHub repo.name 已是 owner/name
  created_at?: string | null;
}

/** 单次取第 1 页公开事件（per_page=100）：只需多样性概览，不深翻（设计 §4.2，REST +1） */
export async function fetchPublicEventsRest(
  octokit: Octokit,
  login: string,
): Promise<GitHubEventRow[]> {
  const res = await octokit.request('GET /users/{username}/events/public', {
    username: login,
    per_page: 100,
  });
  return res.data as GitHubEventRow[];
}

/**
 * 汇总 public events 为源无关 BehaviorEventSummary（方案 B-1）。该端点即本人公开事件，
 * 仍防御性过滤 actor=login；repo.name 已是 owner/name、created_at 为 UTC Z；无有效事件返回 null。
 */
export function summarizeGhEvents(
  rows: GitHubEventRow[],
  login: string,
): BehaviorEventSummary | null {
  const typeCounts = new Map<string, number>();
  const repos = new Set<string>();
  let earliest: string | null = null;
  let latest: string | null = null;
  let total = 0;
  for (const ev of rows) {
    if (!ev) continue;
    if (ev.actor?.login && ev.actor.login.toLowerCase() !== login.toLowerCase()) continue;
    total += 1;
    if (ev.type) typeCounts.set(ev.type, (typeCounts.get(ev.type) ?? 0) + 1);
    if (ev.repo?.name) repos.add(ev.repo.name);
    const at = ev.created_at ?? null;
    if (at && Number.isFinite(Date.parse(at))) {
      if (!earliest || at < earliest) earliest = at;
      if (!latest || at > latest) latest = at;
    }
  }
  if (total === 0) return null;
  return {
    totalEvents: total,
    distinctRepoCount: repos.size,
    eventTypeCounts: Object.fromEntries(typeCounts),
    ...(earliest ? { since: earliest } : {}),
    ...(latest ? { until: latest } : {}),
  };
}

/** 用户公开 email（GitHub 只在用户公开该字段时返回；绝大多数为 null） */
export async function fetchUserEmailRest(octokit: Octokit, login: string): Promise<string | null> {
  const res = await octokit.request('GET /users/{login}', { login });
  const email = (res.data as { email?: string | null }).email;
  return email ?? null;
}

export interface CacheEntry {
  etag: string;
  body: unknown;
}

/** 极简 ETag 缓存（进程内 Map）；GraphQL 无 ETag，仅 REST 请求可用 */
export class HttpCache {
  private readonly store = new Map<string, CacheEntry>();

  get(key: string): CacheEntry | undefined {
    return this.store.get(key);
  }

  set(key: string, entry: CacheEntry): void {
    this.store.set(key, entry);
  }
}

/** Octokit 抛出的 304 Not Modified（条件请求命中） */
export function isNotModifiedError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'status' in err &&
    (err as { status?: unknown }).status === 304
  );
}

/** 带 ETag 条件请求的 REST commit 回退：缓存命中时不再向远端要正文 */
export async function fetchRepoCommitsCached(
  octokit: Octokit,
  cache: HttpCache,
  owner: string,
  repo: string,
  perPage = 30,
): Promise<{ commits: AnalyzerCommit[]; fromCache: boolean }> {
  const key = `commits:${owner}/${repo}`;
  const cached = cache.get(key);
  const headers = cached ? { 'If-None-Match': cached.etag } : undefined;
  try {
    const res = await octokit.request('GET /repos/{owner}/{repo}/commits', {
      owner,
      repo,
      per_page: perPage,
      headers,
    });
    const etag = res.headers.etag;
    if (etag) cache.set(key, { etag, body: res.data });
    return {
      commits: parseRestCommits(res.data as RestCommitRow[], owner, repo),
      fromCache: false,
    };
  } catch (err) {
    if (isNotModifiedError(err) && cached) {
      return {
        commits: parseRestCommits(cached.body as RestCommitRow[], owner, repo),
        fromCache: true,
      };
    }
    throw err;
  }
}

/**
 * 抓取 GitHub 官方成就徽章（Achievements）。
 *
 * 背景（2026-10-29 实测）：GitHub REST API 无 skills/badges/achievements 端点，
 * profile 页徽章是唯一公开入口 —— `https://github.com/{login}?tab=achievements`
 * 返回的 HTML 含 `<img ... alt="Achievement: {name}" class="achievement-badge-sidebar" />`
 * 与 tier 标签（`achievement-tier-label--gold ... x4`）。
 *
 * 诚实边界：这是「官方成就徽章」而非 GitHub Skills 技能验证徽章（后者无公开
 * 数据通道、官方公告未证实 —— 不造数据）。徽章作为 L0 辅助证据源，与官方
 * 徽章共存而非对抗。
 *
 * 走自定义 fetch（测试注入用），不消耗 octokit 配额；失败返回 []（静默降级，
 * collector 以 missing 标注），绝不 throw 中断主采集。
 */
export async function fetchProfileBadges(
  fetchImpl: typeof fetch,
  login: string,
  timeoutMs = 10_000,
): Promise<ProfileBadge[]> {
  const url = `https://github.com/${encodeURIComponent(login)}?tab=achievements`;
  let html: string;
  try {
    const res = await fetchImpl(url, {
      headers: { accept: 'text/html' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return [];
    html = await res.text();
  } catch {
    return [];
  }

  // 徽章条目：<a href="/{login}?achievement={slug}&tab=achievements" ...>
  //   <img ... alt="Achievement: {name}" class="achievement-badge-sidebar" />
  //   [<span ... achievement-tier-label--{level} ...>x{n}</span>]
  // </a>
  const out: ProfileBadge[] = [];
  const seen = new Set<string>();
  let idx = 0;
  for (const img of html.matchAll(/alt="Achievement: ([^"]+)"[^>]*class="achievement-badge-sidebar"/g)) {
    const name = img[1]?.trim();
    if (!name) continue;
    if (seen.has(name)) continue; // profile 侧栏与主区重复渲染，去重
    seen.add(name);
    // tier 就近匹配：徽章图后的 span（x\d+）
    const after = html.slice(img.index ?? 0, (img.index ?? 0) + 400);
    const tierMatch = after.match(/achievement-tier-label--(\w+)[^>]*>\s*(x\d+)/);
    const tier = tierMatch ? `${tierMatch[1]} (${tierMatch[2]})` : undefined;
    out.push({
      name,
      url: `https://github.com/${encodeURIComponent(login)}?achievement=${encodeURIComponent(
        name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''),
      )}&tab=achievements`,
      tier,
    });
    idx += 1;
    if (idx >= 50) break; // 防御：单页徽章数上限
  }
  return out;
}
