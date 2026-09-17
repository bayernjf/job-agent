/**
 * 真实性信号：纯函数规则集（RULE_VERSION 版本化）。
 * 输入 AnalyzerInput（含 evidence 列表），输出 AuthenticitySignal[]；
 * 所有 evidenceRefs 必须指向真实存在的 EvidenceItem，否则被过滤（无证据不下结论）。
 */

import type { AuthenticitySignal, AuthenticityStatus } from '@jobagent/shared';
import type { AnalyzerInput } from './input.js';
import { repoRef } from './input.js';
import { SIGNAL_CODES } from './rules.js';

function normalize(s: string): string {
  return s.toLowerCase().replace(/[\s_.-]/g, '');
}

function matchesIdentity(name: string | null, candidates: string[]): boolean {
  if (!name) return false;
  const n = normalize(name);
  return candidates.some((c) => Boolean(c) && (n === normalize(c) || n.includes(normalize(c))));
}

function validDates(input: AnalyzerInput): string[] {
  const dates = [
    ...input.repos.map((r) => r.pushedAt),
    ...input.commits.map((c) => c.committedAt),
    ...input.pullRequests.map((p) => p.createdAt),
    ...input.issues.map((i) => i.createdAt),
  ].filter((d): d is string => d != null && Number.isFinite(Date.parse(d)));
  return [...new Set(dates)];
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** 过滤出 evidence 中真实存在的引用（防编造） */
function validRefs(input: AnalyzerInput, refs: string[]): string[] {
  const known = new Set(input.evidence.map((e) => e.evidenceId));
  return refs.filter((r) => known.has(r));
}

export function computeAuthenticitySignals(input: AnalyzerInput): AuthenticitySignal[] {
  const signals: AuthenticitySignal[] = [];
  const commitRefs = (commits: AnalyzerInput['commits']) =>
    validRefs(input, commits.slice(0, 5).map((c) => `commit:${c.repoName}:${c.oid}`));

  // 1. author 一致性（2026-09-11 S3 校准：仅 email 不一致多为隐私/noreply 设置，不构成可疑；email 与 name 双重不一致才升级 risk）
  const commits = input.commits.filter((c) => c.authorName || c.authorEmail);
  if (commits.length >= 3) {
    const candidates = [input.subject.login, input.subject.displayName ?? ''];
    const nameRatio =
      commits.filter((c) => matchesIdentity(c.authorName, candidates)).length / commits.length;
    const emailKnown = Boolean(input.subject.email);
    const emailRatio =
      emailKnown && input.subject.email
        ? commits.filter(
            (c) => c.authorEmail && normalize(c.authorEmail) === normalize(input.subject.email!),
          ).length / commits.length
        : null;

    if (emailKnown && emailRatio !== null && emailRatio < 0.3 && nameRatio < 0.5) {
      signals.push({
        code: SIGNAL_CODES.AUTHOR_INCONSISTENCY,
        severity: 'risk',
        label: 'Commit author identity does not match the claimed account',
        detail: `Only ${Math.round(emailRatio * 100)}% of commits use the account's public email and only ${Math.round(nameRatio * 100)}% match its identity`,
        evidenceRefs: commitRefs(commits),
      });
    } else if (emailKnown && emailRatio !== null && emailRatio < 0.3) {
      signals.push({
        code: SIGNAL_CODES.AUTHOR_INCONSISTENCY,
        severity: 'warn',
        label: 'Commit emails rarely match the account public email',
        detail: `Only ${Math.round(emailRatio * 100)}% of sampled commits use the account's public email (private/noreply email is common)`,
        evidenceRefs: commitRefs(commits),
      });
    } else if (!emailKnown && nameRatio < 0.3) {
      signals.push({
        code: SIGNAL_CODES.AUTHOR_INCONSISTENCY,
        severity: 'warn',
        label: 'Commit authors rarely match the account identity',
        detail: `Only ${Math.round(nameRatio * 100)}% of sampled commit author names match the GitHub login or display name`,
        evidenceRefs: commitRefs(commits),
      });
    } else if (nameRatio < 0.7) {
      signals.push({
        code: SIGNAL_CODES.AUTHOR_INCONSISTENCY,
        severity: 'info',
        label: 'Partial author identity mismatch',
        detail: `${Math.round(nameRatio * 100)}% of sampled commit author names match the account identity`,
        evidenceRefs: commitRefs(commits),
      });
    }
  }

  // 2. commit 突发 + 前后长期沉默（搬运/批量灌水特征）
  const byMonth = new Map<string, number>();
  for (const c of input.commits) {
    const key = c.committedAt.slice(0, 7);
    if (key.length === 7) byMonth.set(key, (byMonth.get(key) ?? 0) + 1);
  }
  const monthEntries = [...byMonth.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const totalCommits = input.commits.length;
  for (let i = 0; i < monthEntries.length; i += 1) {
    const [key, count] = monthEntries[i]!;
    const prev = i > 0 ? monthEntries[i - 1]![1] : 0;
    const next = i < monthEntries.length - 1 ? monthEntries[i + 1]![1] : 0;
    if (count >= Math.max(30, totalCommits * 0.5) && prev === 0 && next === 0) {
      const burstCommits = input.commits.filter((c) => c.committedAt.startsWith(key));
      signals.push({
        code: SIGNAL_CODES.COMMIT_BURST,
        severity: 'warn',
        label: 'Commit burst followed by long silence',
        detail: `${count} commits in ${key} with no commits in adjacent months`,
        evidenceRefs: commitRefs(burstCommits),
      });
      break;
    }
  }

  // 3. 长期无活动
  const dates = validDates(input);
  if (dates.length > 0) {
    const latest = dates.reduce((a, b) => (a > b ? a : b));
    const days = (Date.parse(input.collectedAt) - Date.parse(latest)) / 86_400_000;
    if (days > 365) {
      signals.push({
        code: SIGNAL_CODES.STALE_ACTIVITY,
        severity: 'warn',
        label: 'No activity in the last year',
        detail: `Latest GitHub activity was ${Math.round(days / 30)} months ago`,
        evidenceRefs: validRefs(
          input,
          input.repos
            .toSorted((a, b) => (b.pushedAt ?? '').localeCompare(a.pushedAt ?? ''))
            .slice(0, 3)
            .map((r) => `repo:${repoRef(r)}`),
        ),
      });
    } else if (days > 90) {
      signals.push({
        code: SIGNAL_CODES.STALE_ACTIVITY,
        severity: 'info',
        label: 'Low recent activity',
        detail: `Latest GitHub activity was ${Math.round(days / 30)} months ago`,
        evidenceRefs: validRefs(
          input,
          input.repos
            .toSorted((a, b) => (b.pushedAt ?? '').localeCompare(a.pushedAt ?? ''))
            .slice(0, 3)
            .map((r) => `repo:${repoRef(r)}`),
        ),
      });
    }
  }

  // 4. 高 star 与低活跃不匹配
  const totalStars = input.repos.reduce((sum, r) => sum + r.stargazerCount, 0);
  const commitContributions = input.contributions.totalCommitContributions;
  if (totalStars >= 2000 && commitContributions < 10) {
    signals.push({
      code: SIGNAL_CODES.STAR_ACTIVITY_MISMATCH,
      severity: 'risk',
      label: 'High star count with very low commit activity',
      detail: `${totalStars} stars across repos but only ${commitContributions} commit contributions in the last year`,
      evidenceRefs: validRefs(
        input,
        input.repos
          .toSorted((a, b) => b.stargazerCount - a.stargazerCount)
          .slice(0, 3)
          .map((r) => `repo:${repoRef(r)}`),
      ),
    });
  } else if (totalStars >= 500 && commitContributions < 30) {
    signals.push({
      code: SIGNAL_CODES.STAR_ACTIVITY_MISMATCH,
      severity: 'warn',
      label: 'Star count exceeds commit activity',
      detail: `${totalStars} stars across repos with ${commitContributions} commit contributions in the last year`,
      evidenceRefs: validRefs(
        input,
        input.repos
          .toSorted((a, b) => b.stargazerCount - a.stargazerCount)
          .slice(0, 3)
          .map((r) => `repo:${repoRef(r)}`),
      ),
    });
  }


  // 4b. star 与 commit 比例异常（2026-09-11 负样本校准；batch2/v3 校准叠加账号成熟度）
  // star 远多于 commit 可能是买 star、搬运高星项目，但也可能是高声望维护者
  //（项目 star 高、本人采样 commit 少）。区分关键是账号成熟度与协作痕迹：
  // 长期活跃(≥24 月)/大量 merged PR(≥10)/行为总量大(≥150) 的账号判 warn 留人工复核，
  // 只有"短历史、无协作"同时满足时极端比例才升 risk（如 3 个月、0 PR 的买星号）。
  if (totalCommits >= 1) {
    const ratio = totalStars / totalCommits;
    const behaviorHere = input.commits.length + input.pullRequests.length + input.issues.length;
    const mergedPrCount = input.pullRequests.filter((p) => p.state === "MERGED").length;
    const spanMonths =
      dates.length > 0
        ? (Date.parse(input.collectedAt) -
            Math.min(...dates.map((d) => Date.parse(d)))) /
          (30.44 * 86_400_000)
        : null;
    const established =
      (spanMonths !== null && spanMonths >= 24) ||
      mergedPrCount >= 10 ||
      behaviorHere >= 150;
    const rawExtreme = totalStars >= 2000 && ratio >= 50;
    const isRisk = rawExtreme && !established;
    const isWarn = !isRisk && (rawExtreme || (totalStars >= 500 && ratio >= 100));
    if (isRisk || isWarn) {
      signals.push({
        code: SIGNAL_CODES.STAR_TO_COMMIT_RATIO,
        severity: isRisk ? 'risk' : 'warn',
        label: isRisk
          ? 'Star count grossly disproportionate to commit activity'
          : 'Star count disproportionately high relative to commit activity',
        detail: isRisk
          ? `${totalStars} stars across ${totalCommits} sampled commits (ratio ${Math.round(ratio)}:1) with a short history and no collaboration record; strongly suggests purchased stars or a carried-over high-profile repository`
          : `${totalStars} stars across ${totalCommits} sampled commits (ratio ${Math.round(ratio)}:1); ${established ? "high but the account is long-lived with real collaboration, so treat as a maintainer profile and review manually" : "may indicate purchased stars or forked high-profile repos"}`,
        evidenceRefs: validRefs(
          input,
          input.repos
            .toSorted((a, b) => b.stargazerCount - a.stargazerCount)
            .slice(0, 3)
            .map((r) => `repo:${repoRef(r)}`),
        ),
      });
    }
  }

  // 5. 行为证据不足
  const behaviorTotal = input.commits.length + input.pullRequests.length + input.issues.length;
  if (behaviorTotal < 3 && commitContributions < 10) {
    signals.push({
      code: SIGNAL_CODES.EMPTY_ACTIVITY,
      severity: 'info',
      label: 'Not enough behavioral evidence',
      detail: `Only ${behaviorTotal} commit/PR/issue records and ${commitContributions} commit contributions`,
      evidenceRefs: validRefs(input, [`user:${input.subject.login}`]),
    });
  }

  // 6. 活动跨度过短
  if (dates.length > 0) {
    const earliest = dates.reduce((a, b) => (a < b ? a : b));
    const months =
      (Date.parse(input.collectedAt) - Date.parse(earliest)) / (30.44 * 86_400_000);
    if (months < 6) {
      signals.push({
        code: SIGNAL_CODES.SHORT_LONGEVITY,
        severity: 'info',
        label: 'Short activity span',
        detail: `GitHub activity spans about ${Math.max(1, Math.round(months))} months`,
        evidenceRefs: validRefs(input, [`user:${input.subject.login}`]),
      });
    }
  }

  // 7. 被他人项目 merge 的贡献（正向信号，2026-09-11 负样本校准：按数量分级）
  // 1-2 个外部 PR = 弱正向（可能是偶然贡献），3+ 个 = 强正向（持续被外部维护者认可）
  const externalMerged = input.pullRequests.filter((p) => !p.repoOwnerIsSelf && p.state === 'MERGED');
  if (externalMerged.length > 0) {
    const isStrong = externalMerged.length >= 3;
    signals.push({
      code: SIGNAL_CODES.EXTERNAL_CONTRIBUTIONS,
      severity: 'info',
      label: isStrong
        ? 'Strong verified external contributions'
        : 'Merged contributions to external projects',
      detail: `${externalMerged.length} pull request(s) merged into projects not owned by the account (${isStrong ? 'strong positive signal' : 'weak positive signal'})`,
      evidenceRefs: validRefs(
        input,
        externalMerged.slice(0, 5).map((p) => `pr:${p.repoNameWithOwner}:${p.number}`),
      ),
    });
  }

  // 7b. PR 几乎全在自己 repo（2026-09-11 负样本校准新增）
  // 大量 PR 但全在自己 repo，可能是刷 PR 数量；仅在 PR 总数较多时触发
  const allPRs = input.pullRequests;
  const selfPRs = allPRs.filter((p) => p.repoOwnerIsSelf);
  if (allPRs.length >= 20 && selfPRs.length / allPRs.length >= 0.9) {
    signals.push({
      code: SIGNAL_CODES.SELF_PR_RATIO,
      severity: 'warn',
      label: 'Nearly all pull requests are in self-owned repos',
      detail: `${selfPRs.length} of ${allPRs.length} pull requests (${Math.round((selfPRs.length / allPRs.length) * 100)}%) are in self-owned repos; may indicate inflated PR count`,
      evidenceRefs: validRefs(
        input,
        selfPRs.slice(0, 3).map((p) => `pr:${p.repoNameWithOwner}:${p.number}`),
      ),
    });
  }

  // 8. 语言多样性低（弱信息）
  if (input.repos.length >= 5) {
    const languages = new Set(input.repos.map((r) => r.primaryLanguage).filter(Boolean));
    if (languages.size <= 1) {
      signals.push({
        code: SIGNAL_CODES.LOW_DIVERSITY,
        severity: 'info',
        label: 'Single-language portfolio',
        detail: `${input.repos.length} repos but only ${languages.size === 0 ? 'no declared' : [...languages].join(', ')} primary language`,
        evidenceRefs: validRefs(
          input,
          input.repos.slice(0, 3).map((r) => `repo:${repoRef(r)}`),
        ),
      });
    }
  }

  // 8b. 行为高度集中在单一仓库且缺乏协作（规则 0.2 新增，方案 B；设计 design-behavior-diversity-20260915）。
  // 封顶 warn：单仓专注的独立开发者是正常形态，需多条件叠加，且被外部 merged PR 豁免、
  // 被"事件流显示多仓活动 / 协作型事件"反向豁免（采样 top 仓之外的活动只能从 events 看到）。
  const scopeBehaviorTotal = input.commits.length + input.pullRequests.length + input.issues.length;
  const commitsByRepo = new Map<string, number>();
  for (const c of input.commits) {
    commitsByRepo.set(c.repoName, (commitsByRepo.get(c.repoName) ?? 0) + 1);
  }
  const commitRepoCount = commitsByRepo.size;
  const top1CommitShare =
    input.commits.length > 0 ? Math.max(...commitsByRepo.values()) / input.commits.length : 0;
  const scopeExternalMerged = input.pullRequests.filter(
    (p) => !p.repoOwnerIsSelf && p.state === 'MERGED',
  ).length;
  const structurallyNarrow =
    scopeBehaviorTotal >= 30 &&
    scopeExternalMerged === 0 &&
    input.pullRequests.length < 3 &&
    (commitRepoCount <= 1 || top1CommitShare >= 0.9);
  if (structurallyNarrow) {
    const be = input.behaviorEvents;
    const collaborativeEventCount = be
      ? Object.entries(be.eventTypeCounts)
          .filter(([type]) => /PullRequest|Issue|Review|Comment/i.test(type))
          .reduce((sum, [, n]) => sum + n, 0)
      : 0;
    // 事件流反证：多仓活动或协作型事件，说明结构化"单仓"是采样偏差 → 豁免
    const eventsRefuteNarrow =
      be !== undefined && (be.distinctRepoCount >= 2 || collaborativeEventCount > 0);
    if (!eventsRefuteNarrow) {
      const topRepo = [...commitsByRepo.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
      const typeKinds = be ? Object.keys(be.eventTypeCounts).length : 0;
      const narrowRepoRefs = input.repos
        .filter((r) => repoRef(r) === topRepo)
        .map((r) => `repo:${repoRef(r)}`);
      const narrowCommitRefs = input.commits
        .filter((c) => c.repoName === topRepo)
        .slice(0, 3)
        .map((c) => `commit:${c.repoName}:${c.oid}`);
      signals.push({
        code: SIGNAL_CODES.NARROW_ACTIVITY_SCOPE,
        severity: 'warn',
        label: 'Activity concentrated in a single repository with little collaboration',
        detail: be
          ? `${Math.round(top1CommitShare * 100)}% of sampled commits are in one repository, with fewer than 3 PRs, no externally merged PR, and only ${typeKinds} public event type(s) across ${be.distinctRepoCount} repo(s)`
          : `${Math.round(top1CommitShare * 100)}% of sampled commits are in one repository, with fewer than 3 PRs and no externally merged PR`,
        evidenceRefs: validRefs(input, [
          ...narrowRepoRefs,
          ...narrowCommitRefs,
          `user:${input.subject.login}`,
        ]).slice(0, 5),
      });
    }
  }

  // 9. 正向信号抵消（2026-09-11 S3 校准；batch2 校准扩展到 star_to_commit_ratio）：
  // 有外部项目合并的 PR 时，author_inconsistency / star_activity_mismatch /
  // star_to_commit_ratio 的 risk 降级为 warn。
  // 被外部维护者 merge PR 是难以伪造的真实协作证据：author 不一致多为公司/旧邮箱，
  // 高 star 低个人 commit 多为 OSS 名人做管理/架构（项目 star 高、本人采样 commit 少）。
  // 反之，买 star/搬运账号（如 MSNightmare）externalMerged=0，不满足抵消、保持 risk。
  const hasExternalContributions = signals.some(
    (sig) => sig.code === SIGNAL_CODES.EXTERNAL_CONTRIBUTIONS,
  );
  if (hasExternalContributions) {
    for (const sig of signals) {
      if (
        (sig.code === SIGNAL_CODES.AUTHOR_INCONSISTENCY ||
          sig.code === SIGNAL_CODES.STAR_ACTIVITY_MISMATCH ||
          sig.code === SIGNAL_CODES.STAR_TO_COMMIT_RATIO) &&
        sig.severity === 'risk'
      ) {
        sig.severity = 'warn';
        sig.detail += ' (mitigated by verified external contributions)';
      }
    }
  }

  return signals;
}

/** 真实性分级（PRD #2：四级 + 证据 + 置信度；不使用单一"真实度百分比"） */
export function computeAuthenticity(input: AnalyzerInput): {
  status: AuthenticityStatus;
  confidence: number;
  signals: AuthenticitySignal[];
} {
  const signals = computeAuthenticitySignals(input);
  const risks = signals.filter((s) => s.severity === 'risk');
  const warns = signals.filter((s) => s.severity === 'warn');
  const positives = signals.filter((s) => s.code === SIGNAL_CODES.EXTERNAL_CONTRIBUTIONS);
  // 刷 PR（self_pr_ratio）是强负面信号：即便它是唯一 warn，也应判 mixed（需人工判断），
  // 除非有 external_contributions 正向信号抵消（2026-09-17 26 账号回归发现 holilayet 漏报）。
  const hasSelfPrRatio = signals.some((s) => s.code === SIGNAL_CODES.SELF_PR_RATIO);
  const behaviorTotal = input.commits.length + input.pullRequests.length + input.issues.length;
  const externalMerged = input.pullRequests.filter(
    (p) => !p.repoOwnerIsSelf && p.state === 'MERGED',
  ).length;

  // 观察窗口跨度（月）。窗口极短且行为证据总量少、又缺少强外部背书时，
  // 即便没有负面信号也不足以支撑"真实"结论（2026-09-11 batch2 校准）。
  const allDates = validDates(input);
  const longevityMonths =
    allDates.length > 0
      ? (Date.parse(input.collectedAt) -
          Math.min(...allDates.map((d) => Date.parse(d)))) /
        (30.44 * 86_400_000)
      : null;
  const thinEvidence =
    longevityMonths !== null &&
    longevityMonths < 4 &&
    behaviorTotal < 60 &&
    externalMerged < 3;

  let status: AuthenticityStatus;
  if (behaviorTotal < 5 && input.contributions.totalCommitContributions < 20 && externalMerged === 0) {
    status = 'insufficient_data';
  } else if (risks.length > 0) {
    status = 'suspicious';
  } else if (thinEvidence) {
    status = 'mixed_signals';
  } else if (warns.length >= 2 && positives.length === 0) {
    status = 'mixed_signals';
  } else if (hasSelfPrRatio && positives.length === 0) {
    status = 'mixed_signals';
  } else {
    status = 'likely_authentic';
  }

  let confidence = 0.8;
  for (const s of signals) {
    if (s.severity === 'risk') confidence -= 0.2;
    else if (s.severity === 'warn') confidence -= 0.08;
    if (s.code === SIGNAL_CODES.EXTERNAL_CONTRIBUTIONS) {
      // 按数量分级：1-2 个外部 PR 弱正向 +0.05，3+ 个强正向 +0.1
      const extCount = input.pullRequests.filter((pr) => !pr.repoOwnerIsSelf && pr.state === 'MERGED').length;
      confidence += extCount >= 3 ? 0.1 : 0.05;
    }
  }
  if (status === 'insufficient_data') confidence = 0.35;
  if (thinEvidence && status === 'mixed_signals') confidence = Math.min(confidence, 0.6);
  confidence = clamp(Math.round(confidence * 100) / 100, 0.3, 0.95);

  return { status, confidence, signals };
}
