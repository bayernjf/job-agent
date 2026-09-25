/**
 * Mapper（纯函数）：Gitee v5 原始行 → analyzer-core 的证据源无关结构。
 * 全部规则见 docs/design-gitee-source-20260914.md 第 4 节：
 * 时区转 UTC、PII 出口清洗、PR 无增删行填 0、issue 字符串 ident 回退、
 * fork/archived 处理、PR/Issue 按作者过滤、contributions 与 dataWindow 聚合。
 */

import type {
  AnalyzerCommit,
  AnalyzerInput,
  AnalyzerIssue,
  AnalyzerPullRequest,
  AnalyzerRepo,
  AnalyzerSubject,
  BehaviorEventSummary,
  ContributionMonth,
} from '@jobagent/analyzer-core';
import type {
  GiteeCommitRaw,
  GiteeEventRaw,
  GiteeIssueRaw,
  GiteePullRaw,
  GiteeRepoRaw,
  GiteeUserRaw,
} from './types.js';

const GITEE_ORIGIN = 'https://gitee.com';

/** 带 +08:00 偏移的 Gitee 时间统一转 UTC ISO；无法解析返回 null（不伪造） */
export function toUtc(value?: string | null): string | null {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** 解析为有限正整数；Gitee issue 标识可能是非数字字符串，此时返回 null */
function toFiniteInt(value: number | string | null | undefined): number | null {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isInteger(value) ? value : null;
  if (/^\d+$/.test(value.trim())) return Number(value);
  return null;
}

function sameLogin(a: string | null | undefined, b: string): boolean {
  return Boolean(a) && (a as string).toLowerCase() === b.toLowerCase();
}

export function mapSubject(raw: GiteeUserRaw, login: string): AnalyzerSubject {
  return {
    login: raw.login ?? login,
    displayName: raw.name ?? null,
    avatarUrl: raw.avatar_url ?? null,
    profileUrl: raw.html_url ?? `${GITEE_ORIGIN}/${login}`,
    bio: raw.bio ?? null,
    company: raw.company ?? null,
    location: raw.location ?? null,
    email: null, // PII 硬边界：不采集公开邮箱
    createdAt: toUtc(raw.created_at),
    followers: raw.followers ?? 0,
    following: raw.following ?? 0,
    publicRepos: raw.public_repos ?? 0,
  };
}

/** 仓库映射：过滤 fork 与缺关键标识/创建时间的行；ownerLogin 取真实 owner（可能是组织） */
export function mapRepos(rows: GiteeRepoRaw[], login: string): AnalyzerRepo[] {
  const out: AnalyzerRepo[] = [];
  for (const r of rows) {
    if (!r || !r.name || r.fork === true) continue;
    const ownerLogin = r.owner?.login ?? login;
    const createdAt = toUtc(r.created_at);
    if (!createdAt) continue; // 缺创建时间的仓库数据不可用，跳过而非伪造
    out.push({
      name: r.name,
      ownerLogin,
      url: r.html_url ?? `${GITEE_ORIGIN}/${ownerLogin}/${r.name}`,
      isFork: false,
      isArchived: r.archived === true,
      primaryLanguage: r.language ?? null,
      topics: [], // v5 列表无标准 topics，不臆造
      description: r.description ?? null,
      stargazerCount: r.stargazers_count ?? 0,
      forkCount: r.forks_count ?? 0,
      pushedAt: toUtc(r.pushed_at),
      createdAt,
    });
  }
  return out;
}

/**
 * 提交映射 + PII 清洗：authorEmail 恒为 null；authorName 只取顶层公开 login，
 * 不使用 commit.author.name 明文姓名；无可用时间的提交丢弃（时序不可用）。
 */
export function mapCommits(rows: GiteeCommitRaw[], repoNameWithOwner: string): AnalyzerCommit[] {
  const out: AnalyzerCommit[] = [];
  for (const c of rows) {
    if (!c?.sha) continue;
    const committedAt = toUtc(c.commit?.author?.date ?? c.commit?.committer?.date);
    if (!committedAt) continue;
    out.push({
      oid: c.sha,
      committedAt,
      authorName: c.author?.login ?? null,
      authorEmail: null,
      repoName: repoNameWithOwner,
      messageHeadline: (c.commit?.message ?? '').split('\n')[0] ?? '',
    });
  }
  return out;
}

function mapPrState(state: string | null | undefined, mergedAt: string | null): AnalyzerPullRequest['state'] {
  if (mergedAt || state === 'merged') return 'MERGED';
  if (state === 'open') return 'OPEN';
  return 'CLOSED';
}

/** PR 映射：仅保留本人发起；Gitee 无增删行，三字段填 0（设计 4.4）；缺编号/时间丢弃 */
export function mapPullRequests(
  rows: GiteePullRaw[],
  login: string,
  repoNameWithOwner: string,
): AnalyzerPullRequest[] {
  const owner = repoNameWithOwner.split('/')[0] ?? login;
  const out: AnalyzerPullRequest[] = [];
  for (const p of rows) {
    if (!p || !sameLogin(p.user?.login, login)) continue;
    const number = toFiniteInt(p.number);
    const createdAt = toUtc(p.created_at);
    if (number === null || !createdAt) continue;
    out.push({
      number,
      title: p.title ?? '',
      url: p.html_url ?? `${GITEE_ORIGIN}/${repoNameWithOwner}/pulls/${number}`,
      state: mapPrState(p.state, toUtc(p.merged_at)),
      createdAt,
      mergedAt: toUtc(p.merged_at),
      repoNameWithOwner,
      repoIsFork: false,
      repoOwnerIsSelf: owner.toLowerCase() === login.toLowerCase(),
      // Gitee v5 的 PR 列表不提供 diff 统计。这里必须是 null 而不是 0：
      // 填 0 会让"这位候选人改动 0 行"成为一个看起来有据的假结论（T06）。
      additions: null,
      deletions: null,
      changedFiles: null,
    });
  }
  return out;
}

/**
 * Issue 映射：仅保留本人发起；number 为数字时用数字，非数字 ident 回退为本次
 * 列表 1 基序号（仅保证单 AnalyzerInput 内 evidence 引用唯一，原始 ident 留在 url）。
 */
export function mapIssues(
  rows: GiteeIssueRaw[],
  login: string,
  repoNameWithOwner: string,
): AnalyzerIssue[] {
  const out: AnalyzerIssue[] = [];
  let seq = 0;
  for (const i of rows) {
    if (!i || !sameLogin(i.user?.login, login)) continue;
    const createdAt = toUtc(i.created_at);
    if (!createdAt) continue;
    seq += 1;
    const numeric = toFiniteInt(i.number);
    const number = numeric ?? seq;
    const ref = i.ident ?? i.number ?? number;
    out.push({
      number,
      title: i.title ?? '',
      url: i.html_url ?? `${GITEE_ORIGIN}/${repoNameWithOwner}/issues/${ref}`,
      state: i.state === 'open' || i.state === 'progressing' ? 'OPEN' : 'CLOSED',
      createdAt,
      repoNameWithOwner,
    });
  }
  return out;
}

/** 按 YYYY-MM 聚合提交，得到逐月活跃度 */
export function aggregateCommitMonths(commits: AnalyzerCommit[]): ContributionMonth[] {
  const byMonth = new Map<string, number>();
  for (const c of commits) {
    const key = c.committedAt.slice(0, 7);
    if (key.length === 7) byMonth.set(key, (byMonth.get(key) ?? 0) + 1);
  }
  return [...byMonth.entries()]
    .map(([key, count]) => {
      const [year, month] = key.split('-').map(Number);
      return { year: year ?? 0, month: month ?? 0, count };
    })
    .sort((a, b) => a.year - b.year || a.month - b.month);
}

/** Gitee 无 contributionCalendar，由采样窗口内采集结果自聚合（设计 4.7） */
export function buildContributions(
  commits: AnalyzerCommit[],
  pullRequests: AnalyzerPullRequest[],
  issues: AnalyzerIssue[],
  repos: AnalyzerRepo[],
): AnalyzerInput['contributions'] {
  return {
    totalCommitContributions: commits.length,
    totalPullRequestContributions: pullRequests.length,
    totalIssueContributions: issues.length,
    totalRepositoryContributions: repos.length,
    contributionMonths: aggregateCommitMonths(commits),
  };
}

/** dataWindow：since=账号创建；until=最近推送/提交，全空回退 since（设计 4.8） */
export function buildDataWindow(
  sinceIso: string | null,
  repos: AnalyzerRepo[],
  commits: AnalyzerCommit[],
): { since: string; until: string } {
  const since = sinceIso ?? new Date(0).toISOString();
  const candidates = [
    ...repos.map((r) => r.pushedAt),
    ...commits.map((c) => c.committedAt),
  ].filter((d): d is string => Boolean(d));
  const until = candidates.length > 0 ? [...candidates].sort().at(-1)! : since;
  return { since, until };
}

// ---------- events/public 行为流（设计 §4.11，2026-09-15） ----------

/**
 * 仅从 PushEvent 提取提交；非 Push 事件（PR/评论/创建/关注/null）不产生 commit。
 * 时间取事件 created_at（push 时间近似提交时间）；authorName 取动作发出者 actor.login
 * （本人），绝不使用 payload.commits[].author 明文姓名/邮箱，authorEmail 恒为 null；
 * actor 非本人、缺仓库名/时间/sha 的条目跳过。
 */
export function mapEventsToCommits(events: GiteeEventRaw[], login: string): AnalyzerCommit[] {
  const out: AnalyzerCommit[] = [];
  for (const ev of events) {
    if (!ev || ev.type !== 'PushEvent') continue;
    if (!sameLogin(ev.actor?.login, login)) continue;
    const repoName = ev.repo?.full_name ?? ev.repo?.human_name ?? null;
    const committedAt = toUtc(ev.created_at);
    if (!repoName || !committedAt) continue;
    for (const c of ev.payload?.commits ?? []) {
      if (!c?.sha) continue;
      out.push({
        oid: c.sha,
        committedAt,
        authorName: ev.actor?.login ?? null,
        authorEmail: null, // PII 硬边界：payload.commits[].author.email 明文，不采集
        repoName,
        messageHeadline: (c.message ?? '').split('\n')[0] ?? '',
      });
    }
  }
  return out;
}

/** 提交去重键：仓库内 sha，与 evidenceId `commit:${repo}:${oid}` 同口径 */
/**
 * 汇总本人 public events 为源无关 BehaviorEventSummary（方案 B-1，设计 §2/§4.1）：
 * 只统计 actor 为本人的事件；distinctRepo 用 repo.full_name/human_name 去重；
 * eventTypeCounts 统计非空 type；时间窗由 created_at（+08:00→UTC）min/max 得到；
 * 无本人有效事件返回 null（不产生空摘要，内核据此走结构化降级）。
 */
export function summarizeGiteeEvents(
  events: GiteeEventRaw[],
  login: string,
): BehaviorEventSummary | null {
  const typeCounts = new Map<string, number>();
  const repos = new Set<string>();
  let earliest: string | null = null;
  let latest: string | null = null;
  let total = 0;
  for (const ev of events) {
    if (!ev || !sameLogin(ev.actor?.login, login)) continue;
    total += 1;
    if (ev.type) typeCounts.set(ev.type, (typeCounts.get(ev.type) ?? 0) + 1);
    const repoName = ev.repo?.full_name ?? ev.repo?.human_name ?? null;
    if (repoName) repos.add(repoName);
    const at = toUtc(ev.created_at);
    if (at) {
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

function commitKey(c: AnalyzerCommit): string {
  return `${c.repoName}:${c.oid}`;
}

/**
 * 合并逐仓采样 commits 与 events 补入 commits：按 `repo:oid` 去重、采样优先
 * （采样带精确 commit author date），events 只补采样未覆盖的近期提交，结果按时间升序。
 */
export function mergeSampledAndEventCommits(
  sampled: AnalyzerCommit[],
  fromEvents: AnalyzerCommit[],
): AnalyzerCommit[] {
  const seen = new Set<string>();
  const merged: AnalyzerCommit[] = [];
  for (const c of sampled) {
    const key = commitKey(c);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(c);
  }
  for (const c of fromEvents) {
    const key = commitKey(c);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(c);
  }
  merged.sort((a, b) => a.committedAt.localeCompare(b.committedAt));
  return merged;
}
