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
  const catalogTags = computeCatalogTags(input, known);
  tags.push(...catalogTags);

  // --- topics 兜底（T05）：目录没收的能力也得说得出 ---
  tags.push(
    ...computeTopicFallbackTags(input, known, [
      ...languageTags,
      ...catalogTags,
    ]),
  );

  return tags;
}

/**
 * topics 兜底标签（T05，2026-09-25）。
 *
 * 目录是 framework/domain 的唯一生产者，所以一个没被收录的技术就永远进不了画像
 * （GitHub 上 agent/RAG 生态的 topic 每天都在变，改码追不上）。topics 是仓库作者
 * 自己打的、平台结构化的标签，证据强度仅次于"外部 PR 被合并"，够格单独出标签。
 *
 * 保守四件套，防止一个话题热的仓库把画像灌水（规则来自 2026-09-25 真账号实测，
 * 首轮兜底产出了 `github config` / `developer tools` / `software delivery` 这类
 * 不是技术的"话题词"，据此收紧）：
 * 1. **只走 topics**，不碰自由文本（描述里的 "ai" 什么都可能是）；
 * 2. **同一 topic 至少出现在 2 个仓库**——单仓话题只是碰巧，两仓才是持续投入；
 * 3. 深度一律 `used`（作者自打的标签能证明"做过这个领域"，证明不了熟练度），
 *    置信度上限 0.6（目录内词条可到 0.85）；
 * 4. 最多 3 条，且与已产出的标签/别名/语言去重，通用词与类别词直接丢弃。
 */
const TOPIC_SHAPE = /^[a-z0-9][a-z0-9.+_#-]{1,29}$/;

/** 与"这项技能"无关的通用词/平台词/元话题词/类别词（含 GitHub 官方话题噪声）。 */
const TOPIC_STOPWORDS = new Set([
  'app', 'apps', 'web', 'website', 'api', 'ui', 'ux', 'cli', 'tool', 'tools', 'library', 'framework',
  'project', 'projects', 'code', 'coding', 'example', 'examples', 'demo', 'template', 'templates',
  'starter', 'boilerplate', 'awesome', 'learn', 'learning', 'tutorial', 'tutorials', 'course',
  'docs', 'documentation', 'guideline', 'guidelines', 'styleguide', 'config', 'dotfiles',
  'github', 'git', 'gitlab', 'vscode', 'idea', 'personal', 'portfolio', 'my', 'test', 'tests',
  'testing', 'wip', 'archive', 'archived', 'deprecated', 'fun', 'stuff', 'misc', 'miscellaneous',
  'open-source', 'opensource', 'hacktoberfest', 'good-first-issue', 'help-wanted',
  'javascript', 'typescript', 'python', 'java', 'golang', 'rust', 'cpp', 'csharp', 'php', 'ruby',
  // 真账号实测里出现的"类别词/元话题词"：描述的是软件怎么交付，不是技术能力
  'github-config', 'github config', 'developer-tools', 'developer tools', 'software-delivery',
  'software delivery', 'product-delivery', 'product delivery', 'tooling', 'workflow', 'workflows',
  'automation', 'dashboard', 'manager', 'platform', 'system', 'services', 'service', 'ai', 'ml',
]);

/** 兜底标签的规范名：小写、连字符转空格，与目录词条的显示风格一致。 */
function topicDisplayName(topic: string): string {
  return topic.replace(/[-_.]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function computeTopicFallbackTags(
  input: AnalyzerInput,
  known: Set<string>,
  alreadyProduced: SkillTag[],
): SkillTag[] {
  // 已出过标签的名字与别名一律不再兜底产出，避免同一能力两个写法
  const taken = new Set<string>();
  for (const tag of alreadyProduced) {
    taken.add(tag.name.toLowerCase());
    taken.add(topicDisplayName(tag.name.toLowerCase()));
  }
  for (const entry of SKILL_CATALOG) {
    taken.add(entry.name);
    taken.add(topicDisplayName(entry.name));
    for (const alias of entry.aliases) {
      taken.add(alias);
      taken.add(topicDisplayName(alias));
    }
  }

  const byTopic = new Map<string, { repos: string[] }>();
  for (const repo of input.repos) {
    const ref = repoRef(repo);
    for (const raw of repo.topics) {
      const topic = raw.trim().toLowerCase();
      if (!TOPIC_SHAPE.test(topic)) continue;
      if (TOPIC_STOPWORDS.has(topic)) continue;
      const display = topicDisplayName(topic);
      if (!display || TOPIC_STOPWORDS.has(display)) continue;
      if (taken.has(topic) || taken.has(display)) continue;
      const bucket = byTopic.get(topic) ?? { repos: [] };
      if (!bucket.repos.includes(ref)) bucket.repos.push(ref);
      byTopic.set(topic, bucket);
    }
  }

  const candidates: SkillTag[] = [];
  for (const [topic, bucket] of byTopic) {
    // 规则 2：单仓话题丢弃，两仓以上才算持续投入
    if (bucket.repos.length < 2) continue;
    const evidenceRefs = bucket.repos.slice(0, 3).map((r) => `repo:${r}`).filter((r) => known.has(r));
    if (evidenceRefs.length === 0) continue; // 无证据不下结论
    const raw = 0.4 + 0.08 * (bucket.repos.length - 1);
    candidates.push({
      name: topicDisplayName(topic),
      kind: 'framework',
      depth: 'used', // 规则 3：作者自打的 topics 能证明方向，证明不了熟练度
      confidence: clamp(Math.round(raw * 100) / 100, 0.3, 0.6),
      evidenceRefs,
    });
  }

  return candidates
    .sort((a, b) => b.confidence - a.confidence || a.name.localeCompare(b.name))
    .slice(0, 3);
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

  // 上限从 8 提到 10（T05 同批）：AI/Agent 层进词典后，一个全栈 agent 开发者的
  // 框架标签数已经越过 8——实测 bayernjf 的 vue 被挤掉。上限的作用是防灌水，
  // 不是牺牲真实技术，所以先放宽到 10，等 T14 之后按真实画像分布再校。
  const frameworks = produced
    .filter((t) => t.kind === 'framework')
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 10);
  const domains = produced
    .filter((t) => t.kind === 'domain')
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 4);
  return [...frameworks, ...domains];
}
