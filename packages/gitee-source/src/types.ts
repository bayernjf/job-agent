/**
 * gitee-source：Gitee 证据源（第二个 EvidenceSource，2026-09-14）。
 *
 * 职责：用 Gitee Open API v5（REST-only，无公开 GraphQL）采集账号 L0 元数据与
 * L1 行为时序，产出与 github-source 同构、analyzer-core 可直接消费的 AnalyzerInput
 * 与 EvidenceItem（sourcePlatform='gitee'）。
 *
 * 设计依据：docs/design-gitee-source-20260914.md；差异实测见
 * docs/design-gitee-source-spike-20260914.md。
 * 约束：匿名可读公开数据、token 仅可选提额；PII（commit 邮箱/明文姓名）在出口清洗；
 * 任一层失败显式标注缺失，禁止输出"看似完整"的数据。
 */

import type { AnalyzerInput } from '@jobagent/analyzer-core';
import type { EvidenceItem } from '@jobagent/shared';

/** 一次采集的全部产出：分析输入 + 证据 + 元信息（形态对齐 GitHubCollectedData） */
export interface GiteeCollectedData {
  input: AnalyzerInput;
  evidence: EvidenceItem[];
  meta: {
    /** 本次采集实际消耗的 REST 请求次数（Gitee 无 GraphQL 点计费） */
    budgetUsed: { restCalls: number };
    /** 显式缺失标注；空数组表示无缺失 */
    missing: string[];
    /** events/public 取到的事件条数（行为流补充，设计 §4.11） */
    eventsFetched?: number;
    /** 由 events 的 PushEvent 补入、逐仓采样未覆盖的 commit 条数 */
    eventCommitsAdded?: number;
  };
}

/** 单画像请求预算（匿名约 60 次/分钟，默认 56 留余量） */
export interface GiteeBudget {
  restCalls: number;
}

export interface GiteeSourceOptions {
  /** 可选私人令牌（GITEE_TOKEN）：匿名也可读公开数据，token 仅用于提额 */
  token?: string;
  budget?: Partial<GiteeBudget>;
  log?: Pick<Console, 'info' | 'warn' | 'error'>;
  /** 自定义 fetch（测试注入用；默认 Node 全局 fetch） */
  fetch?: typeof fetch;
  /** 注入退避等待（测试立即 resolve；默认 setTimeout） */
  sleep?: (ms: number) => Promise<void>;
  /** 参与 L1 提交/PR/Issue 采集的最大非归档仓库数（默认 8） */
  maxCommitRepos?: number;
  /** 单仓最近提交条数（默认 30） */
  commitsPerRepo?: number;
  /** 仓库列表每页条数（默认 100，Gitee 上限 100） */
  repoPerPage?: number;
  /** 仓库列表最多翻页数（兜底，默认 3） */
  maxRepoPages?: number;
}

// ---------- Gitee v5 原始响应（只声明使用到的字段，对缺失字段健壮） ----------

export interface GiteeOwnerRaw {
  login?: string | null;
}

export interface GiteeUserRaw {
  login: string;
  name?: string | null;
  avatar_url?: string | null;
  html_url?: string | null;
  bio?: string | null;
  company?: string | null;
  location?: string | null;
  /** 公开邮箱：PII，出口不使用（subject.email 恒为 null） */
  email?: string | null;
  created_at?: string | null;
  followers?: number;
  following?: number;
  public_repos?: number;
}

export interface GiteeRepoRaw {
  name?: string | null;
  full_name?: string | null;
  html_url?: string | null;
  fork?: boolean;
  archived?: boolean;
  language?: string | null;
  description?: string | null;
  stargazers_count?: number;
  forks_count?: number;
  pushed_at?: string | null;
  created_at?: string | null;
  owner?: GiteeOwnerRaw | null;
}

export interface GiteeCommitPersonRaw {
  name?: string | null;
  email?: string | null;
  date?: string | null;
}

export interface GiteeCommitRaw {
  sha?: string | null;
  commit?: {
    message?: string | null;
    author?: GiteeCommitPersonRaw | null;
    committer?: GiteeCommitPersonRaw | null;
  } | null;
  /** 顶层作者：公开登录名（非明文姓名），用于 commit authorName */
  author?: GiteeOwnerRaw | null;
}

export interface GiteePullRaw {
  number?: number | string | null;
  title?: string | null;
  html_url?: string | null;
  /** open / closed / merged */
  state?: string | null;
  created_at?: string | null;
  merged_at?: string | null;
  user?: GiteeOwnerRaw | null;
}

export interface GiteeIssueRaw {
  number?: number | string | null;
  /** Gitee issue 的区分大小写字符串标识（可能非纯数字，实测见 spike） */
  ident?: string | null;
  title?: string | null;
  html_url?: string | null;
  /** open / progressing / closed / rejected ... */
  state?: string | null;
  created_at?: string | null;
  user?: GiteeOwnerRaw | null;
}

/** PushEvent.payload.commits[] 单个提交；author 为明文（含邮箱形态），PII 出口不使用 */
export interface GiteeEventCommitRaw {
  sha?: string | null;
  message?: string | null;
  author?: { name?: string | null; email?: string | null } | null;
}

/**
 * /users/{login}/events/public 单条事件（2026-09-15 行为流补充，设计 §4.11）。
 * 实测：只返回最近 20 条，page/per_page 均被忽略、深翻重复第 1 页，故只取一次。
 */
export interface GiteeEventRaw {
  id?: string | null;
  /** PushEvent/PullRequestEvent/PullRequestCommentEvent/IssueCommentEvent/CreateEvent/FollowEvent；实测可能为 null */
  type?: string | null;
  actor?: GiteeOwnerRaw | null;
  repo?: { full_name?: string | null; human_name?: string | null } | null;
  created_at?: string | null;
  payload?: {
    ref?: string | null;
    size?: number;
    before?: string | null;
    after?: string | null;
    commits?: GiteeEventCommitRaw[] | null;
  } | null;
}
