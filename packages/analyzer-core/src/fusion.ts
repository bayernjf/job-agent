/**
 * 跨源镜像去重与最小双源融合（B-5，2026-09-15；设计 docs/design-cross-source-fusion-20260915.md）。
 *
 * 把两个证据源各自产出的 AnalyzerInput（通常 GitHub 主、Gitee 辅）融合为一份去重后的
 * AnalyzerInput，使 analyze() 内核只看到一份普通输入、对"融合"无感知。
 *
 * 镜像判据：两仓存在相同 git commit oid（SHA 跨平台全局一致）= 确定镜像，自动合并；
 * 仅仓库短名相同 = 疑似，只报告不合并（保守，避免同名巧合错并）。纯函数、零 I/O、确定性。
 */

import type { EvidenceItem, SupportedPlatform } from '@jobagent/shared';
import { repoRef, type AnalyzerCommit, type AnalyzerInput, type AnalyzerRepo } from './input.js';

export interface MirrorPair {
  primaryRef: string;
  secondaryRef: string;
  sharedOidCount: number;
}

export interface SuspectedMirror {
  primaryRef: string;
  secondaryRef: string;
  reason: 'same_name';
}

export interface FusionReport {
  primaryPlatform: SupportedPlatform;
  secondaryPlatform: SupportedPlatform;
  /** 确定镜像（共享 commit oid），已合并 */
  mergedMirrors: MirrorPair[];
  /** 疑似镜像（仅同名），只报告未合并 */
  suspectedMirrors: SuspectedMirror[];
  /** 因镜像而丢弃的重复 commit 数 */
  dedupedCommitCount: number;
  /** 保留下来的辅源仓库（独有 + 疑似未并） */
  keptSecondaryRepoRefs: string[];
  counts: {
    primaryRepos: number;
    secondaryRepos: number;
    fusedRepos: number;
    primaryCommits: number;
    secondaryCommits: number;
    fusedCommits: number;
  };
}

export interface FusionResult {
  input: AnalyzerInput;
  report: FusionReport;
}

function minIso(a: string | null | undefined, b: string | null | undefined): string | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return a < b ? a : b;
}

function maxIso(a: string | null | undefined, b: string | null | undefined): string | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return a > b ? a : b;
}

interface Detection {
  /** 辅源 repoRef -> 主源 repoRef（确定镜像） */
  mirrorBySecondary: Map<string, string>;
  pairs: MirrorPair[];
  suspected: SuspectedMirror[];
}

/** 检测镜像：共享 oid 强配对（一对一），剩余按同名报疑似 */
function detectMirrors(primary: AnalyzerInput, secondary: AnalyzerInput): Detection {
  // 辅源 oid -> 出现该 oid 的辅源仓集合
  const oidToSecondary = new Map<string, Set<string>>();
  for (const c of secondary.commits) {
    let set = oidToSecondary.get(c.oid);
    if (!set) {
      set = new Set();
      oidToSecondary.set(c.oid, set);
    }
    set.add(c.repoName);
  }

  // 主源各仓的 oid 列表
  const primaryRepoOids = new Map<string, string[]>();
  for (const c of primary.commits) {
    const list = primaryRepoOids.get(c.repoName) ?? [];
    list.push(c.oid);
    primaryRepoOids.set(c.repoName, list);
  }

  const mirrorBySecondary = new Map<string, string>();
  const pairs: MirrorPair[] = [];
  const usedSecondary = new Set<string>();

  for (const repo of primary.repos) {
    const pRef = repoRef(repo);
    const hit = new Map<string, number>();
    for (const oid of primaryRepoOids.get(pRef) ?? []) {
      const secs = oidToSecondary.get(oid);
      if (!secs) continue;
      for (const sRef of secs) hit.set(sRef, (hit.get(sRef) ?? 0) + 1);
    }
    let best: string | undefined;
    let bestN = 0;
    for (const [sRef, n] of hit) {
      if (usedSecondary.has(sRef)) continue;
      if (n > bestN) {
        best = sRef;
        bestN = n;
      }
    }
    if (best && bestN >= 1) {
      usedSecondary.add(best);
      mirrorBySecondary.set(best, pRef);
      pairs.push({ primaryRef: pRef, secondaryRef: best, sharedOidCount: bestN });
    }
  }

  // 剩余未配对仓按短名小写相等报疑似（只报不并）
  const primaryMatched = new Set(pairs.map((p) => p.primaryRef));
  const secByName = new Map<string, string>();
  for (const repo of secondary.repos) {
    const sRef = repoRef(repo);
    if (usedSecondary.has(sRef)) continue;
    secByName.set(repo.name.toLowerCase(), sRef);
  }
  const suspected: SuspectedMirror[] = [];
  const weakUsed = new Set<string>();
  for (const repo of primary.repos) {
    const pRef = repoRef(repo);
    if (primaryMatched.has(pRef)) continue;
    const sRef = secByName.get(repo.name.toLowerCase());
    if (sRef && !weakUsed.has(sRef)) {
      weakUsed.add(sRef);
      suspected.push({ primaryRef: pRef, secondaryRef: sRef, reason: 'same_name' });
    }
  }

  return { mirrorBySecondary, pairs, suspected };
}

function mergeRepo(primary: AnalyzerRepo, secondary: AnalyzerRepo): AnalyzerRepo {
  const topics = [...primary.topics];
  for (const tp of secondary.topics) {
    if (!topics.some((x) => x.toLowerCase() === tp.toLowerCase())) topics.push(tp);
  }
  return {
    ...primary,
    topics,
    description: primary.description ?? secondary.description,
    primaryLanguage: primary.primaryLanguage ?? secondary.primaryLanguage,
    // 同一项目热度取大、不相加，避免翻倍
    stargazerCount: Math.max(primary.stargazerCount, secondary.stargazerCount),
    forkCount: Math.max(primary.forkCount, secondary.forkCount),
    pushedAt: maxIso(primary.pushedAt, secondary.pushedAt),
    createdAt: minIso(primary.createdAt, secondary.createdAt) ?? primary.createdAt,
    isArchived: primary.isArchived || secondary.isArchived,
  };
}

/** 重写 commit/pr/issue 证据 evidenceId 的 repo 段（保留原始 url 供溯源） */
function remapEvidence(evidence: EvidenceItem, mirror: Map<string, string>): EvidenceItem {
  const firstColon = evidence.evidenceId.indexOf(':');
  const prefix = evidence.evidenceId.slice(0, firstColon);
  const rest = evidence.evidenceId.slice(firstColon + 1);
  const lastColon = rest.lastIndexOf(':');
  const ref = rest.slice(0, lastColon);
  const tail = rest.slice(lastColon + 1);
  const mapped = mirror.get(ref);
  if (!mapped) return evidence;
  return { ...evidence, evidenceId: `${prefix}:${mapped}:${tail}` };
}

export function fuseInputs(
  primary: AnalyzerInput,
  secondary: AnalyzerInput,
  platforms?: { primary?: SupportedPlatform; secondary?: SupportedPlatform },
): FusionResult {
  const primaryPlatform = platforms?.primary ?? 'github';
  const secondaryPlatform = platforms?.secondary ?? 'gitee';
  const { mirrorBySecondary, pairs, suspected } = detectMirrors(primary, secondary);
  const secondaryRepoByRef = new Map(secondary.repos.map((r) => [repoRef(r), r]));

  // --- repos：主源为基底合并镜像，辅源独有/疑似仓追加 ---
  const fusedRepos: AnalyzerRepo[] = primary.repos.map((p) => {
    const pRef = repoRef(p);
    const secRef = [...mirrorBySecondary.entries()].find(([, pr]) => pr === pRef)?.[0];
    const sec = secRef ? secondaryRepoByRef.get(secRef) : undefined;
    return sec ? mergeRepo(p, sec) : p;
  });
  const keptSecondaryRepoRefs: string[] = [];
  for (const s of secondary.repos) {
    const sRef = repoRef(s);
    if (!mirrorBySecondary.has(sRef)) {
      keptSecondaryRepoRefs.push(sRef);
      fusedRepos.push(s);
    }
  }

  // --- commits：镜像重复 oid 去重，镜像独有 oid 重映射保留，其余原样 ---
  const primaryOids = new Set(primary.commits.map((c) => c.oid));
  const seenCommit = new Set(primary.commits.map((c) => `${c.repoName}:${c.oid}`));
  const fusedCommits: AnalyzerCommit[] = [...primary.commits];
  let dedupedCommitCount = 0;
  for (const c of secondary.commits) {
    const mapped = mirrorBySecondary.get(c.repoName);
    if (mapped) {
      if (primaryOids.has(c.oid)) {
        dedupedCommitCount += 1; // 镜像重复提交
        continue;
      }
      const nc: AnalyzerCommit = { ...c, repoName: mapped };
      const key = `${mapped}:${c.oid}`;
      if (!seenCommit.has(key)) {
        seenCommit.add(key);
        fusedCommits.push(nc);
      }
    } else {
      const key = `${c.repoName}:${c.oid}`;
      if (!seenCommit.has(key)) {
        seenCommit.add(key);
        fusedCommits.push({ ...c });
      }
    }
  }
  fusedCommits.sort((a, b) => (a.committedAt < b.committedAt ? -1 : a.committedAt > b.committedAt ? 1 : 0));

  // --- PR / Issue：不跨源去重；镜像仓的重映射 repoRef 后保留 ---
  const fusedPRs = [
    ...primary.pullRequests,
    ...secondary.pullRequests.map((p) => {
      const mapped = mirrorBySecondary.get(p.repoNameWithOwner);
      return mapped ? { ...p, repoNameWithOwner: mapped } : { ...p };
    }),
  ];
  const fusedIssues = [
    ...primary.issues,
    ...secondary.issues.map((i) => {
      const mapped = mirrorBySecondary.get(i.repoNameWithOwner);
      return mapped ? { ...i, repoNameWithOwner: mapped } : { ...i };
    }),
  ];

  // --- evidence：镜像 repo 证据丢弃，commit/pr/issue 证据重映射，按 id 去重 ---
  const seenEvidence = new Set<string>();
  const fusedEvidence: EvidenceItem[] = [];
  const pushEvidence = (e: EvidenceItem): void => {
    if (!seenEvidence.has(e.evidenceId)) {
      seenEvidence.add(e.evidenceId);
      fusedEvidence.push(e);
    }
  };
  primary.evidence.forEach(pushEvidence);
  for (const e of secondary.evidence) {
    if (e.sourceType === 'repo') {
      const ref = e.evidenceId.slice('repo:'.length);
      if (mirrorBySecondary.has(ref)) continue; // 并入主源 repo 证据
      pushEvidence(e);
      continue;
    }
    pushEvidence(remapEvidence(e, mirrorBySecondary));
  }

  // --- behaviorEvents：计数相加、跨仓广度保守取 max、窗口取并 ---
  const a = primary.behaviorEvents;
  const b = secondary.behaviorEvents;
  let behaviorEvents = primary.behaviorEvents;
  if (a && b) {
    const eventTypeCounts = { ...a.eventTypeCounts };
    for (const [k, v] of Object.entries(b.eventTypeCounts)) {
      eventTypeCounts[k] = (eventTypeCounts[k] ?? 0) + v;
    }
    behaviorEvents = {
      totalEvents: a.totalEvents + b.totalEvents,
      distinctRepoCount: Math.max(a.distinctRepoCount, b.distinctRepoCount),
      eventTypeCounts,
      since: minIso(a.since, b.since) ?? undefined,
      until: maxIso(a.until, b.until) ?? undefined,
    };
  } else if (b) {
    behaviorEvents = { ...b };
  }

  // --- subject：主源为基底，空字段用辅源补；跨源不可加的计数取主源 ---
  const ps = primary.subject;
  const ts = secondary.subject;
  const subject = {
    ...ps,
    displayName: ps.displayName ?? ts.displayName,
    avatarUrl: ps.avatarUrl ?? ts.avatarUrl,
    bio: ps.bio ?? ts.bio,
    company: ps.company ?? ts.company,
    location: ps.location ?? ts.location,
    email: ps.email ?? ts.email,
    createdAt: ps.createdAt ?? ts.createdAt,
    publicRepos: fusedRepos.length,
  };

  const missing = [...new Set([...primary.missing, ...secondary.missing])];

  const input: AnalyzerInput = {
    subject,
    dataWindow: {
      since: minIso(primary.dataWindow.since, secondary.dataWindow.since) ?? primary.dataWindow.since,
      until: maxIso(primary.dataWindow.until, secondary.dataWindow.until) ?? primary.dataWindow.until,
    },
    repos: fusedRepos,
    commits: fusedCommits,
    pullRequests: fusedPRs,
    issues: fusedIssues,
    // 贡献计数以主源为基底、不与辅源相加（镜像会虚增）；辅源独有仓 commit 已并入 commits
    contributions: { ...primary.contributions, contributionMonths: [...primary.contributions.contributionMonths] },
    evidence: fusedEvidence,
    missing,
    collectedAt: maxIso(primary.collectedAt, secondary.collectedAt) ?? primary.collectedAt,
    ...(behaviorEvents ? { behaviorEvents } : {}),
  };

  const report: FusionReport = {
    primaryPlatform,
    secondaryPlatform,
    mergedMirrors: pairs,
    suspectedMirrors: suspected,
    dedupedCommitCount,
    keptSecondaryRepoRefs,
    counts: {
      primaryRepos: primary.repos.length,
      secondaryRepos: secondary.repos.length,
      fusedRepos: fusedRepos.length,
      primaryCommits: primary.commits.length,
      secondaryCommits: secondary.commits.length,
      fusedCommits: fusedCommits.length,
    },
  };

  return { input, report };
}
