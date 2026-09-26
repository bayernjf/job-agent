/**
 * 项目条目解析（T13，设计 C-C 第 9 条）：一条经历 = 主体 + 动作 + 规模 + 结果 + 证据链接。
 *
 * 输入是画像证据（EvidenceItem），输出是结构化 ProjectEntry。
 * 只解析 EvidenceSource 自产的**稳定 claim 格式**（github-source/src/evidence.ts 生成、
 * evidence.test.ts 钉住），解析不出就跳过该证据——绝不猜主体/规模。
 *
 * 覆盖四类：
 *  - PR:  `PR "TITLE" (OWNER/REPO#N)` [+ ` · +A/-D across N files`]
 *  - Issue: `Issue "TITLE" (OWNER/REPO#N)`
 *  - Commit: `Commit <sha> (<repo>)`（fallback claim；messageHeadline 形式无 repo 信息，跳过）
 *  - Repo: `Repository OWNER/NAME [(lang)]: N stars / N forks, last pushed ...`
 *
 * no-fabrication：产出的条目一律带非空 evidenceRefs，由 ProjectEntrySchema superRefine 强制。
 */
import type { EvidenceItem, EvidenceSourceType, ProjectEntry } from '@jobagent/shared';

/** PR：`PR "TITLE" (OWNER/REPO#N)` 或带 ` · +A/-D across N files` 后缀（T06 格式） */
const PR_RE =
  /^PR "([^"]*)" \(([^()#]+)#(\d+)\)(?:\s*·\s*\+(\d+)\/-(\d+) across (\d+) files)?$/;

/** Issue：`Issue "TITLE" (OWNER/REPO#N)` */
const ISSUE_RE = /^Issue "([^"]*)" \(([^()#]+)#(\d+)\)$/;

/** Commit fallback：`Commit <sha> (<repo>)`（messageHeadline 形式无 repo 后缀，不解析） */
const COMMIT_RE = /^Commit ([0-9a-f]{7,40}) \(([^)]+)\)$/;

/** Repo：`Repository OWNER/NAME [(lang)]: N stars / N forks, last pushed ...` */
const REPO_RE = /^Repository ([^ (]+)\/([^ (]+)(?: \(([^)]+)\))?: (\d+) stars \/ (\d+) forks/;

/** 证据强度（与 rank.ts 的 EVIDENCE_STRENGTH 同序，解析层只排序不展开全表） */
const ACTION_STRENGTH: Record<string, number> = {
  pr: 4,
  issue: 3,
  commit: 1,
  repo: 0,
};

/** 单条证据 → 项目条目；格式不匹配返回 null（跳过，不猜）。 */
export function parseProjectEntry(item: EvidenceItem): ProjectEntry | null {
  const refs = [item.evidenceId];
  const base = {
    url: item.url,
    occurredAt: item.occurredAt,
    evidenceRefs: refs,
  };

  if (item.sourceType === 'pr') {
    const m = PR_RE.exec(item.claim);
    if (!m || !m[1] || !m[2]) return null;
    const title = m[1];
    const project = m[2];
    const add = m[4];
    const del = m[5];
    const files = m[6];
    const scale =
      add !== undefined ? `+${add}/-${del} across ${files} files` : undefined;
    return { ...base, project, action: 'pr', title, scale };
  }

  if (item.sourceType === 'issue') {
    const m = ISSUE_RE.exec(item.claim);
    if (!m || !m[1] || !m[2]) return null;
    return { ...base, project: m[2], action: 'issue', title: m[1] };
  }

  if (item.sourceType === 'commit') {
    const m = COMMIT_RE.exec(item.claim);
    if (!m || !m[1] || !m[2]) return null;
    return { ...base, project: m[2], action: 'commit', title: `Commit ${m[1]}` };
  }

  if (item.sourceType === 'repo') {
    const m = REPO_RE.exec(item.claim);
    if (!m || !m[1] || !m[2] || !m[4] || !m[5]) return null;
    const owner = m[1];
    const name = m[2];
    const stars = m[4];
    const forks = m[5];
    return {
      ...base,
      project: `${owner}/${name}`,
      action: 'repo',
      title: `${owner}/${name}`,
      scale: `${stars} stars / ${forks} forks`,
    };
  }

  return null;
}

/**
 * 从证据全集构建项目条目列表。
 * 排序：动作强度（PR > Issue > Commit > Repo）→ 时间新→旧（无时间排最后）；
 * limit>0 时切片（默认与 evidenceHighlights 同上限）。
 */
export function projectEntriesFromEvidence(
  allEvidence: readonly EvidenceItem[],
  limit = 0,
): ProjectEntry[] {
  const entries: ProjectEntry[] = [];
  for (const item of allEvidence) {
    const entry = parseProjectEntry(item);
    if (entry) entries.push(entry);
  }
  entries.sort((a, b) => {
    const byStrength = (ACTION_STRENGTH[b.action] ?? 0) - (ACTION_STRENGTH[a.action] ?? 0);
    if (byStrength !== 0) return byStrength;
    const ta = a.occurredAt;
    const tb = b.occurredAt;
    if (ta && tb) return tb.localeCompare(ta);
    if (tb) return 1;
    if (ta) return -1;
    return 0;
  });
  return limit > 0 ? entries.slice(0, limit) : entries;
}

/** 动作枚举 → 展示词（证据 claim 的英文口径，T 批次 41 定稿；渲染层不做翻译，保持可回溯）。 */
export function actionLabel(action: EvidenceSourceType): string {
  switch (action) {
    case 'pr':
      return 'PR';
    case 'issue':
      return 'Issue';
    case 'commit':
      return 'Commit';
    case 'repo':
      return 'Repository';
    default:
      return action;
  }
}
