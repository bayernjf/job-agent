/**
 * L3 语义层规则内核（纯函数、无 I/O；设计见 docs/design-semantic-layer-20261011.md）。
 *
 * 输入 L3SemanticInput（采集器产出），输出 L3Signals（规则版信号）。
 * 纪律：只出 code + facts；缺失标记透传（缺失不得当作"没有"）；
 * 规则变更必须升 SEMANTIC_RULE_VERSION 并钉字面量测试。
 */
import {
  L3_DOMAIN_HINTS,
  L3_TECHSTACK_DICTIONARY,
  SEMANTIC_RULE_VERSION,
  type L3RepoFiles,
  type L3RepoSignal,
  type L3SemanticInput,
  type L3Signals,
} from '@jobagent/shared';

/** 成熟度信号上限：跨仓库归并去重后的标签数 */
const SUMMARY_TECH_MAX = 20;
const SUMMARY_DOMAIN_MAX = 10;
const REPO_TECH_MAX = 20;
const REPO_DOMAIN_MAX = 10;

export function analyzeSemantic(input: L3SemanticInput): L3Signals {
  const repos: L3RepoSignal[] = input.repos.map(analyzeRepo);
  const techStack = unique(
    repos.flatMap((r) => r.techStack),
    SUMMARY_TECH_MAX,
  );
  const domainHints = unique(
    repos.flatMap((r) => r.domainHints),
    SUMMARY_DOMAIN_MAX,
  );
  return { ruleVersion: SEMANTIC_RULE_VERSION, repos, summary: { techStack, domainHints } };
}

function analyzeRepo(repo: L3RepoFiles): L3RepoSignal {
  const tree = repo.fileTree;
  const description = (repo.description ?? '').toLowerCase();
  const topics = repo.topics.map((t) => t.toLowerCase());

  const hasTests = tree.some((p) => {
    const lower = p.toLowerCase();
    return (
      lower.includes('tests/') ||
      lower.includes('__tests__/') ||
      lower.includes('.test.') ||
      lower.includes('.spec.')
    );
  });
  const hasCi = tree.some((p) => {
    const lower = p.toLowerCase();
    return (
      lower.includes('.github/workflows') ||
      lower.includes('.gitlab-ci.yml') ||
      lower.includes('.travis.yml') ||
      lower.includes('.circleci/')
    );
  });
  const hasDocs = repo.readmeExcerpt.length >= 200;
  const hasLicense = tree.some((p) => {
    const upper = p.toUpperCase();
    return upper.startsWith('LICENSE') || upper.startsWith('COPYING');
  });
  const hasDockerfile = tree.some((p) => {
    const upper = p.toUpperCase();
    return upper.startsWith('DOCKERFILE') || upper.includes('DOCKER-COMPOSE');
  });

  const starBand: L3RepoSignal['maturity']['starBand'] =
    repo.starred === 0 ? 'none' : repo.starred < 100 ? 'low' : repo.starred < 1000 ? 'mid' : 'high';

  return {
    owner: repo.owner,
    name: repo.name,
    maturity: {
      hasTests,
      hasCi,
      hasDocs,
      hasLicense,
      hasDockerfile,
      fileCount: tree.length,
      starBand,
    },
    techStack: unique(parseTechStack(repo), REPO_TECH_MAX),
    repoKind: classifyRepoKind(repo, description, topics),
    domainHints: unique(parseDomainHints(description, topics), REPO_DOMAIN_MAX),
    missing: repo.missing,
  };
}

/** 依赖清单 → 技术栈标签（白名单精确匹配包名；尽力而为解析，不追求完整） */
function parseTechStack(repo: L3RepoFiles): string[] {
  const tags = new Set<string>();
  for (const [path, content] of Object.entries(repo.keyFiles)) {
    if (path.endsWith('package.json')) {
      for (const dep of parseJsonDeps(content)) tags.add(mapDep(dep));
    } else if (path.endsWith('pyproject.toml')) {
      for (const dep of parsePyprojectDeps(content)) tags.add(mapDep(dep));
    } else if (path.endsWith('go.mod')) {
      for (const mod of parseGoModRequires(content)) tags.add(mapDep(mod));
    } else if (path.endsWith('Cargo.toml')) {
      for (const dep of parseCargoDeps(content)) tags.add(mapDep(dep));
    } else if (path === 'requirements.txt') {
      for (const dep of parseRequirements(content)) tags.add(mapDep(dep));
    }
  }
  return [...tags].filter(Boolean).sort();
}

function mapDep(dep: string): string {
  // go 模块路径取首段（github.com / gitlab.com / golang.org）再查字典
  const key =
    dep.startsWith('github.com') || dep.startsWith('gitlab.com') || dep.startsWith('golang.org')
      ? (dep.split('/')[0] ?? '')
      : dep;
  return L3_TECHSTACK_DICTIONARY[key] ?? '';
}

function parseJsonDeps(content: string): string[] {
  try {
    const json = JSON.parse(content) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };
    return Object.keys({ ...json.dependencies, ...json.devDependencies, ...json.peerDependencies });
  } catch {
    return [];
  }
}

function parsePyprojectDeps(content: string): string[] {
  const deps: string[] = [];
  const re = /(?:optional-)?dependencies\s*=\s*\[([\s\S]*?)\n\s*\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    for (const line of (m[1] ?? '').split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('[')) continue;
      const name = trimmed.replace(/^["']/, '').split(/[<>=!~[@]/)[0]?.trim();
      if (name) deps.push(name);
    }
  }
  return deps;
}

function parseGoModRequires(content: string): string[] {
  const mods: string[] = [];
  const lines = content.split(/\r?\n/);
  let inBlock = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === 'require (') {
      inBlock = true;
      continue;
    }
    if (trimmed === ')') {
      inBlock = false;
      continue;
    }
    if (trimmed.startsWith('require ') && !trimmed.endsWith('(')) {
      const first = trimmed.split(/\s+/)[1];
      if (first) mods.push(first);
      continue;
    }
    if (inBlock) {
      const first = trimmed.split(/\s+/)[0];
      if (first) mods.push(first);
    }
  }
  return mods;
}

function parseCargoDeps(content: string): string[] {
  const deps: string[] = [];
  const lines = content.split(/\r?\n/);
  let inDeps = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[dependencies')) {
      inDeps = true;
      continue;
    }
    if (trimmed.startsWith('[')) {
      inDeps = false;
      continue;
    }
    if (!inDeps || !trimmed || trimmed.startsWith('#')) continue;
    const name = trimmed.split(/\s*=/)[0]?.trim();
    if (name) deps.push(name);
  }
  return deps;
}

function parseRequirements(content: string): string[] {
  const deps: string[] = [];
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('-')) continue;
    const name = trimmed.split(/[<>=!~[]/)[0]?.trim();
    if (name) deps.push(name);
  }
  return deps;
}

function classifyRepoKind(
  repo: L3RepoFiles,
  description: string,
  topics: string[],
): L3RepoSignal['repoKind'] {
  const haystack = `${description} ${topics.join(' ')}`;
  if (/\b(template|boilerplate|starter|scaffold)\b/.test(haystack)) return 'boilerplate';
  if (/\bframework\b/.test(haystack)) return 'framework';
  if (/\blibrary\b/.test(haystack)) return 'library';
  if (/\b(cli|tool|utility|command-line)\b/.test(haystack)) return 'tool';
  if (repo.readmeExcerpt.trim().length > 0 || repo.fileTree.length > 0) return 'application';
  return 'unknown';
}

function parseDomainHints(description: string, topics: string[]): string[] {
  const hints: string[] = [];
  const haystack = `${description} ${topics.join(' ')}`;
  for (const hint of L3_DOMAIN_HINTS) {
    if (new RegExp(`\\b${hint}\\b`).test(haystack)) hints.push(hint);
  }
  return hints;
}

function unique(values: string[], max: number): string[] {
  return [...new Set(values)].slice(0, max);
}
