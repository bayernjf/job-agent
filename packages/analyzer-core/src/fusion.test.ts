import { describe, expect, it } from 'vitest';
import { fuseInputs } from './fusion.js';
import { buildInput } from './test-input.js';
import { repoRef, type AnalyzerCommit, type AnalyzerInput, type AnalyzerPullRequest, type AnalyzerRepo } from './input.js';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
const D = 'd'.repeat(40);
const E = 'e'.repeat(40);

function repo(name: string, ownerLogin: string, partial: Partial<AnalyzerRepo> = {}): AnalyzerRepo {
  return {
    name,
    ownerLogin,
    url: `https://example.com/${ownerLogin}/${name}`,
    isFork: false,
    isArchived: false,
    primaryLanguage: null,
    topics: [],
    description: null,
    stargazerCount: 1,
    forkCount: 0,
    pushedAt: '2026-06-01T00:00:00Z',
    createdAt: '2024-01-01T00:00:00Z',
    ...partial,
  };
}

function commit(oid: string, repoName: string, committedAt: string, messageHeadline = 'wip'): AnalyzerCommit {
  return { oid, repoName, committedAt, messageHeadline, authorName: 'Alice', authorEmail: 'a@x.com' };
}

function pr(number: number, repoNameWithOwner: string, title = 'pr'): AnalyzerPullRequest {
  return {
    number,
    title,
    url: `https://example.com/${repoNameWithOwner}/pull/${number}`,
    state: 'MERGED',
    createdAt: '2026-05-01T00:00:00Z',
    mergedAt: '2026-05-02T00:00:00Z',
    repoNameWithOwner,
    repoIsFork: false,
    repoOwnerIsSelf: true,
    additions: 10,
    deletions: 2,
    changedFiles: 2,
  };
}

/** 构造一对"GitHub 主 + Gitee 辅"输入，含镜像仓 / 同名仓 / 各自独有仓 */
function buildPair(): { primary: AnalyzerInput; secondary: AnalyzerInput } {
  const primary = buildInput({
    login: 'alice',
    repos: [
      repo('webapp', 'alice', { primaryLanguage: 'TypeScript', topics: ['react'], description: 'web app', stargazerCount: 10 }),
      repo('only-gh', 'alice', { primaryLanguage: 'Go', description: 'gh only', stargazerCount: 5 }),
      repo('blog', 'alice', { description: 'my blog', stargazerCount: 1 }),
    ],
    commits: [
      commit(A, 'alice/webapp', '2026-01-01T10:00:00Z'),
      commit(B, 'alice/webapp', '2026-02-01T10:00:00Z'),
      commit(D, 'alice/only-gh', '2026-03-01T10:00:00Z'),
    ],
    pullRequests: [pr(1, 'alice/webapp', 'gh pr')],
    issues: [],
  });

  const secondary = buildInput({
    login: 'aliceg',
    repos: [
      repo('webapp', 'aliceg', { topics: ['vue'], stargazerCount: 20 }), // 镜像（共享 A/B）
      repo('only-gitee', 'aliceg', { primaryLanguage: 'Python', description: 'gitee only', stargazerCount: 3 }),
      repo('blog', 'aliceg', { description: 'gitee blog', stargazerCount: 2 }), // 仅同名
    ],
    commits: [
      commit(A, 'aliceg/webapp', '2026-01-01T10:00:00Z'), // 重复
      commit(B, 'aliceg/webapp', '2026-02-01T10:00:00Z'), // 重复
      commit(C, 'aliceg/webapp', '2026-02-15T10:00:00Z'), // 镜像仓独有提交
      commit(E, 'aliceg/only-gitee', '2026-04-01T10:00:00Z'),
    ],
    pullRequests: [pr(7, 'aliceg/webapp', 'gitee pr')],
    issues: [],
  });
  secondary.evidence.forEach((e) => {
    e.sourcePlatform = 'gitee';
  });
  return { primary, secondary };
}

/** 融合后每条 repo/commit/pr/issue 数据都能在 evidence 中找到对应证据（无悬空） */
function expectEvidenceResolvable(input: AnalyzerInput): void {
  const ids = new Set(input.evidence.map((e) => e.evidenceId));
  for (const r of input.repos) expect(ids.has(`repo:${repoRef(r)}`)).toBe(true);
  for (const c of input.commits) expect(ids.has(`commit:${c.repoName}:${c.oid}`)).toBe(true);
  for (const p of input.pullRequests) expect(ids.has(`pr:${p.repoNameWithOwner}:${p.number}`)).toBe(true);
  for (const i of input.issues) expect(ids.has(`issue:${i.repoNameWithOwner}:${i.number}`)).toBe(true);
}

describe('fuseInputs', () => {
  it('merges a shared-oid mirror and dedupes repeated commits', () => {
    const { primary, secondary } = buildPair();
    const { input, report } = fuseInputs(primary, secondary);

    expect(report.mergedMirrors).toEqual([
      { primaryRef: 'alice/webapp', secondaryRef: 'aliceg/webapp', sharedOidCount: 2 },
    ]);
    // 3 + 3 - 1 合并 = 5；辅源镜像仓不再单独存在
    expect(report.counts.fusedRepos).toBe(5);
    expect(input.repos.find((r) => repoRef(r) === 'aliceg/webapp')).toBeUndefined();

    // 合并仓：star 取 max、topics 并集、语言主源优先
    const merged = input.repos.find((r) => repoRef(r) === 'alice/webapp');
    expect(merged?.stargazerCount).toBe(20);
    expect(merged?.topics).toEqual(['react', 'vue']);
    expect(merged?.primaryLanguage).toBe('TypeScript');

    // A/B 去重只留一份，C 保留，D/E 保留 → 共 5；丢弃 2 条重复
    expect(report.dedupedCommitCount).toBe(2);
    expect(report.counts.fusedCommits).toBe(5);
    const oids = input.commits.map((c) => c.oid);
    expect(oids.filter((o) => o === A)).toHaveLength(1);
    expect(oids.filter((o) => o === B)).toHaveLength(1);
    expect(oids).toContain(C);
    // 时间升序
    const times = input.commits.map((c) => c.committedAt);
    expect([...times]).toEqual([...times].sort());
  });

  it('treats same-name repos without shared oid as suspected only (no merge)', () => {
    const { primary, secondary } = buildPair();
    const { input, report } = fuseInputs(primary, secondary);
    expect(report.suspectedMirrors).toEqual([
      { primaryRef: 'alice/blog', secondaryRef: 'aliceg/blog', reason: 'same_name' },
    ]);
    // 两个同名仓都保留
    expect(input.repos.find((r) => repoRef(r) === 'alice/blog')).toBeDefined();
    expect(input.repos.find((r) => repoRef(r) === 'aliceg/blog')).toBeDefined();
    expect(report.keptSecondaryRepoRefs).toContain('aliceg/blog');
  });

  it('keeps a mirror-only secondary commit and remaps it to the primary repo', () => {
    const { primary, secondary } = buildPair();
    const { input } = fuseInputs(primary, secondary);
    const c = input.commits.find((x) => x.oid === C);
    expect(c).toBeDefined();
    expect(c?.repoName).toBe('alice/webapp');
  });

  it('keeps a secondary-only repo with its commit and remaps its mirror PR', () => {
    const { primary, secondary } = buildPair();
    const { input } = fuseInputs(primary, secondary);
    expect(input.repos.find((r) => repoRef(r) === 'aliceg/only-gitee')).toBeDefined();
    expect(input.commits.find((c) => c.oid === E && c.repoName === 'aliceg/only-gitee')).toBeDefined();
    // 镜像仓的 Gitee PR 被重映射到主源仓
    const giteePr = input.pullRequests.find((p) => p.number === 7);
    expect(giteePr?.repoNameWithOwner).toBe('alice/webapp');
  });

  it('produces self-consistent evidence with no dangling refs', () => {
    const { primary, secondary } = buildPair();
    const { input } = fuseInputs(primary, secondary);
    expectEvidenceResolvable(input);
    const ids = new Set(input.evidence.map((e) => e.evidenceId));
    // 镜像辅源 repo 证据被并入主源、不再单独存在；重映射的 PR 证据在主源 ref 下
    expect(ids.has('repo:aliceg/webapp')).toBe(false);
    expect(ids.has('pr:alice/webapp:7')).toBe(true);
  });

  it('does not inflate contributions, takes primary subject, and unions the time window', () => {
    const { primary, secondary } = buildPair();
    secondary.dataWindow = { since: '2015-01-01T00:00:00Z', until: '2030-01-01T00:00:00Z' };
    const { input } = fuseInputs(primary, secondary);
    // 贡献计数取主源、不与辅源相加（两份默认都是 486）
    expect(input.contributions.totalCommitContributions).toBe(primary.contributions.totalCommitContributions);
    expect(input.subject.login).toBe('alice');
    expect(input.subject.publicRepos).toBe(5);
    expect(input.dataWindow.since).toBe('2015-01-01T00:00:00Z');
    expect(input.dataWindow.until).toBe('2030-01-01T00:00:00Z');
  });

  it('is deterministic for identical inputs', () => {
    const { primary, secondary } = buildPair();
    const r1 = fuseInputs(primary, secondary);
    const r2 = fuseInputs(primary, secondary);
    expect(JSON.stringify(r2)).toEqual(JSON.stringify(r1));
  });
});
