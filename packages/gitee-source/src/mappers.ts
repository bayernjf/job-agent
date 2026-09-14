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
  ContributionMonth,
} from '@jobagent/analyzer-core';
import type {
  GiteeCommitRaw,
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
      additions: 0,
      deletions: 0,
      changedFiles: 0,
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
