/**
 * 真实性信号：纯函数规则集（RULE_VERSION 版本化）。
 * 输入 AnalyzerInput（含 evidence 列表），输出 AuthenticitySignal[]；
 * 所有 evidenceRefs 必须指向真实存在的 EvidenceItem，否则被过滤（无证据不下结论）。
 */

import type { AuthenticitySignal, AuthenticityStatus } from '@jobagent/shared';
import type { AnalyzerInput } from './input.js';
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
  ].filter((d) => Number.isFinite(Date.parse(d)));
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
            .toSorted((a, b) => b.pushedAt.localeCompare(a.pushedAt))
            .slice(0, 3)
            .map((r) => `repo:${r.name}`),
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
            .toSorted((a, b) => b.pushedAt.localeCompare(a.pushedAt))
            .slice(0, 3)
            .map((r) => `repo:${r.name}`),
        ),
      });
    }
  }

  // 4. 高 star 与低活跃不匹配
  const totalStars = input.repos.reduce((sum, r) => sum + r.stargazerCount, 0);
  const commitContributions = input.contributions.totalCommitContributions;
  if (totalStars >= 200 && commitContributions < 20) {
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
          .map((r) => `repo:${r.name}`),
      ),
    });
  } else if (totalStars >= 200 && commitContributions < 60) {
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
          .map((r) => `repo:${r.name}`),
      ),
    });
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

  // 7. 被他人项目 merge 的贡献（强正向）
  const externalMerged = input.pullRequests.filter((p) => !p.repoOwnerIsSelf && p.state === 'MERGED');
  if (externalMerged.length > 0) {
    signals.push({
      code: SIGNAL_CODES.EXTERNAL_CONTRIBUTIONS,
      severity: 'info',
      label: 'Merged contributions to external projects',
      detail: `${externalMerged.length} pull request(s) merged into projects not owned by the account`,
      evidenceRefs: validRefs(
        input,
        externalMerged.slice(0, 5).map((p) => `pr:${p.repoNameWithOwner}:${p.number}`),
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
          input.repos.slice(0, 3).map((r) => `repo:${r.name}`),
        ),
      });
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
  const behaviorTotal = input.commits.length + input.pullRequests.length + input.issues.length;
  const externalMerged = input.pullRequests.filter(
    (p) => !p.repoOwnerIsSelf && p.state === 'MERGED',
  ).length;

  let status: AuthenticityStatus;
  if (behaviorTotal < 5 && input.contributions.totalCommitContributions < 20 && externalMerged === 0) {
    status = 'insufficient_data';
  } else if (risks.length > 0) {
    status = 'suspicious';
  } else if (warns.length >= 2 && positives.length === 0) {
    status = 'mixed_signals';
  } else {
    status = 'likely_authentic';
  }

  let confidence = 0.8;
  for (const s of signals) {
    if (s.severity === 'risk') confidence -= 0.2;
    else if (s.severity === 'warn') confidence -= 0.08;
    if (s.code === SIGNAL_CODES.EXTERNAL_CONTRIBUTIONS) confidence += 0.1;
  }
  if (status === 'insufficient_data') confidence = 0.35;
  confidence = clamp(Math.round(confidence * 100) / 100, 0.3, 0.95);

  return { status, confidence, signals };
}
