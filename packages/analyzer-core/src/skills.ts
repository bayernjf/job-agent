/**
 * 能力标签：
 * - language：从仓库主语言分布（L0）推导（B-4 未改动，逻辑已合理）。
 * - framework/domain：B-4 起从 topics / description / 仓库名 / commit 标题 / PR 标题多信号提取，
 *   词典见 skills-catalog.ts，词边界防误匹配、别名归一、标签必挂真实证据。
 * 标签必挂证据；置信度按证据强度保守估计。设计：docs/design-skill-extraction-20260915.md。
 */

import type { SkillTag } from '@jobagent/shared';
import type { AnalyzerInput } from './input.js';
import { repoRef } from './input.js';
import {
  SKILL_CATALOG,
  compileEntryRegex,
  topicMatchesEntry,
  type SkillEntry,
} from './skills-catalog.js';

interface LangStat {
  name: string;
  repoNames: string[];
  lastPush: string;
  commitCount: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function pushUnique(arr: string[], value: string): void {
  if (!arr.includes(value)) arr.push(value);
}

export function computeSkillTags(input: AnalyzerInput): SkillTag[] {
  const tags: SkillTag[] = [];
  const known = new Set(input.evidence.map((e) => e.evidenceId));
  const refs = (names: string[]) => names.filter((n) => known.has(`repo:${n}`)).map((n) => `repo:${n}`);

  // --- language：按仓库主语言聚合（保持原逻辑） ---
  const stats = new Map<string, LangStat>();
  for (const repo of input.repos) {
    if (!repo.primaryLanguage) continue;
    const stat = stats.get(repo.primaryLanguage) ?? {
      name: repo.primaryLanguage,
      repoNames: [],
      lastPush: '',
      commitCount: 0,
    };
    stat.repoNames.push(repoRef(repo));
    if (repo.pushedAt && repo.pushedAt > stat.lastPush) stat.lastPush = repo.pushedAt;
    stat.commitCount += input.commits.filter((c) => c.repoName === repoRef(repo)).length;
    stats.set(repo.primaryLanguage, stat);
  }
  const now = input.collectedAt;
  const languageTags: SkillTag[] = [...stats.values()]
    .map((s) => {
      const activeRecently =
        Number.isFinite(Date.parse(s.lastPush)) &&
        (Date.parse(now) - Date.parse(s.lastPush)) / 86_400_000 <= 365;
      const depth: 'proficient' | 'used' =
        (s.repoNames.length >= 2 && activeRecently) || s.commitCount >= 20 ? 'proficient' : 'used';
      const confidence = clamp(Math.round((0.45 + 0.12 * s.repoNames.length) * 100) / 100, 0.3, 0.9);
      return {
        name: s.name,
        kind: 'language' as const,
        depth,
        confidence,
        evidenceRefs: refs(s.repoNames.slice(0, 3)),
      };
    })
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 6);
  tags.push(...languageTags);

  // --- framework / domain：多信号精确提取（B-4） ---
  tags.push(...computeCatalogTags(input, known));

  return tags;
}

/** 单个技术词条在全部信号源上的聚合命中 */
interface SkillAggregate {
  entry: SkillEntry;
  /** 在 topics/description/name 命中的仓 */
  repoHits: Set<string>;
  /** 其中经 topics 精确命中的仓（强信号子集） */
  topicRepos: Set<string>;
  /** commit/PR 标题命中条数（行为佐证） */
  behaviorCount: number;
  /** 候选证据 id（repo:/commit:/pr:），保序去重 */
  refList: string[];
}

function computeCatalogTags(input: AnalyzerInput, known: Set<string>): SkillTag[] {
  const aggregates = new Map<string, SkillAggregate>();

  for (const entry of SKILL_CATALOG) {
    const regex = compileEntryRegex(entry);
    const agg: SkillAggregate = {
      entry,
      repoHits: new Set(),
      topicRepos: new Set(),
      behaviorCount: 0,
      refList: [],
    };
    let touched = false;

    // 仓库级信号：topics 精确 + description/name 词边界
    for (const repo of input.repos) {
      const ref = repoRef(repo);
      let hit = false;
      if (repo.topics.some((topic) => topicMatchesEntry(topic, entry))) {
        agg.topicRepos.add(ref);
        hit = true;
      }
      // 仓库名的 -/_ 视为词分隔，便于 nextjs-blog 命中 nextjs
      const freeText = `${repo.name.replace(/[-_]/g, ' ')} ${repo.description ?? ''}`;
      if (regex.test(freeText)) hit = true;
      if (hit) {
        agg.repoHits.add(ref);
        pushUnique(agg.refList, `repo:${ref}`);
        touched = true;
      }
    }

    // 行为级信号：commit / PR 标题
    for (const commit of input.commits) {
      if (regex.test(commit.messageHeadline)) {
        agg.behaviorCount += 1;
        pushUnique(agg.refList, `commit:${commit.repoName}:${commit.oid}`);
        touched = true;
      }
    }
    for (const pr of input.pullRequests) {
      if (regex.test(pr.title)) {
        agg.behaviorCount += 1;
        pushUnique(agg.refList, `pr:${pr.repoNameWithOwner}:${pr.number}`);
        touched = true;
      }
    }

    if (touched) aggregates.set(entry.name, agg);
  }

  const produced: SkillTag[] = [];
  for (const agg of aggregates.values()) {
    // repo 证据最多 3、行为证据最多 2，且必须真实存在
    const repoEvidence = agg.refList.filter((r) => r.startsWith('repo:')).slice(0, 3);
    const behaviorEvidence = agg.refList.filter((r) => !r.startsWith('repo:')).slice(0, 2);
    const evidenceRefs = [...repoEvidence, ...behaviorEvidence].filter((r) => known.has(r));
    if (evidenceRefs.length === 0) continue; // 无证据不下结论

    const repoCount = agg.repoHits.size;
    const hasTopic = agg.topicRepos.size > 0;
    const hasBehavior = agg.behaviorCount > 0;
    const depth: 'proficient' | 'used' =
      repoCount >= 2 || (hasTopic && hasBehavior) || agg.behaviorCount >= 3 ? 'proficient' : 'used';

    const cap = agg.entry.kind === 'domain' ? 0.7 : 0.85;
    const raw = 0.4 + (hasTopic ? 0.15 : 0) + 0.06 * Math.max(0, repoCount - 1) + (hasBehavior ? 0.1 : 0);
    const confidence = clamp(Math.round(raw * 100) / 100, 0.3, cap);

    produced.push({
      name: agg.entry.name,
      kind: agg.entry.kind,
      depth,
      confidence,
      evidenceRefs,
    });
  }

  const frameworks = produced
    .filter((t) => t.kind === 'framework')
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 8);
  const domains = produced
    .filter((t) => t.kind === 'domain')
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 4);
  return [...frameworks, ...domains];
}
