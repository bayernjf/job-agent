/**
 * 能力标签：从仓库语言分布（L0）推导 language，从 topics/description（L0）匹配
 * framework/domain。MVP 只做浅层信号，标签必挂证据；置信度按证据强度保守估计。
 */

import type { SkillTag } from '@jobagent/shared';
import type { AnalyzerInput } from './input.js';

interface LangStat {
  name: string;
  repoNames: string[];
  lastPush: string;
  commitCount: number;
}

const FRAMEWORK_PATTERNS: Array<{ name: string; patterns: RegExp[] }> = [
  { name: 'react', patterns: [/react/i] },
  { name: 'vue', patterns: [/vue/i] },
  { name: 'next.js', patterns: [/next\.?js/i] },
  { name: 'astro', patterns: [/astro/i] },
  { name: 'hono', patterns: [/hono/i] },
  { name: 'express', patterns: [/express/i] },
  { name: 'drizzle', patterns: [/drizzle/i] },
  { name: 'spring', patterns: [/spring/i] },
  { name: 'django', patterns: [/django/i] },
  { name: 'fastapi', patterns: [/fastapi/i] },
  { name: 'flutter', patterns: [/flutter/i] },
  { name: 'react native', patterns: [/react native/i] },
  { name: 'electron', patterns: [/electron/i] },
];

const DOMAIN_PATTERNS: Array<{ name: string; patterns: RegExp[] }> = [
  { name: 'frontend', patterns: [/frontend/i, /web app/i, /ui/i, /landing/i] },
  { name: 'backend', patterns: [/backend/i, /server/i, /api/i, /database/i] },
  { name: 'data-ml', patterns: [/data/i, /machine learning/i, /ml\b/i, /llm/i, /ai\b/i, /pytorch/i, /tensorflow/i] },
  { name: 'devops', patterns: [/devops/i, /docker/i, /kubernetes/i, /k8s/i, /terraform/i, /ci\/cd/i, /actions/i] },
  { name: 'mobile', patterns: [/android/i, /ios/i, /mobile/i] },
  { name: 'blockchain', patterns: [/blockchain/i, /web3/i, /ethereum/i, /solidity/i] },
  { name: 'game', patterns: [/game/i, /unity/i, /unreal/i] },
];

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function repoText(repo: AnalyzerInput['repos'][number]): string {
  return [repo.name, repo.description ?? '', ...repo.topics].join(' ');
}

function matchTags(text: string, table: Array<{ name: string; patterns: RegExp[] }>): string[] {
  return table.filter((t) => t.patterns.some((p) => p.test(text))).map((t) => t.name);
}

export function computeSkillTags(input: AnalyzerInput): SkillTag[] {
  const tags: SkillTag[] = [];
  const known = new Set(input.evidence.map((e) => e.evidenceId));
  const refs = (names: string[]) => names.filter((n) => known.has(`repo:${n}`)).map((n) => `repo:${n}`);

  // --- language：按仓库主语言聚合 ---
  const stats = new Map<string, LangStat>();
  for (const repo of input.repos) {
    if (!repo.primaryLanguage) continue;
    const stat = stats.get(repo.primaryLanguage) ?? {
      name: repo.primaryLanguage,
      repoNames: [],
      lastPush: '',
      commitCount: 0,
    };
    stat.repoNames.push(repo.name);
    if (repo.pushedAt > stat.lastPush) stat.lastPush = repo.pushedAt;
    stat.commitCount += input.commits.filter((c) => c.repoName === repo.name).length;
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

  // --- framework / domain：按 topics + description 匹配词典 ---
  const matchedFrameworks = new Map<string, string[]>();
  const matchedDomains = new Map<string, string[]>();
  for (const repo of input.repos) {
    const text = repoText(repo);
    for (const fw of matchTags(text, FRAMEWORK_PATTERNS)) {
      matchedFrameworks.set(fw, [...(matchedFrameworks.get(fw) ?? []), repo.name]);
    }
    for (const dm of matchTags(text, DOMAIN_PATTERNS)) {
      matchedDomains.set(dm, [...(matchedDomains.get(dm) ?? []), repo.name]);
    }
  }
  const frameworkTags: SkillTag[] = [...matchedFrameworks.entries()]
    .map(([name, repoNames]) => ({
      name,
      kind: 'framework' as const,
      depth: (repoNames.length >= 2 ? 'proficient' : 'used') as 'proficient' | 'used',
      confidence: clamp(Math.round((0.4 + 0.1 * repoNames.length) * 100) / 100, 0.3, 0.7),
      evidenceRefs: refs(repoNames.slice(0, 3)),
    }))
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 4);
  tags.push(...frameworkTags);

  const domainTags: SkillTag[] = [...matchedDomains.entries()]
    .map(([name, repoNames]) => ({
      name,
      kind: 'domain' as const,
      depth: (repoNames.length >= 3 ? 'proficient' : 'used') as 'proficient' | 'used',
      confidence: clamp(Math.round((0.4 + 0.08 * repoNames.length) * 100) / 100, 0.3, 0.7),
      evidenceRefs: refs(repoNames.slice(0, 3)),
    }))
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 4);
  tags.push(...domainTags);

  return tags;
}
