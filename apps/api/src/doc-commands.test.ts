/**
 * 文档里的命令必须真能跑（与 api-doc-consistency / env-doc-consistency / doc-links
 * 同一族「文档即被测面」守护，随 `pnpm -r test` 在 CI 实跑）。
 *
 * 这条守护的来源是连续三次同类故障：`scripts/migrate-down` 调用了 CLI 不存在的
 * 子命令形态（所以它从来没跑通过，而 AGENTS 与 MIGRATION_CONVENTION 都在宣传它）、
 * docs/API.md 的 `DEMO_SESSION_TTL_MS` 默认值与代码不符、handoff 写 `pnpm release`
 * 而根 package.json 根本没有这个 script。人眼对不齐，就钉成测试。
 *
 * 覆盖现行操作文档（仓库根 *.md + docs/*.md），**排除 `handoff-archive-*`**：
 * 归档是冻结的历史流水，其中的命令快照属于当时状态，不作为可跑性承诺。
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '../../..');

function operationalDocs(): string[] {
  const rootMd = readdirSync(REPO_ROOT).filter((f) => f.endsWith('.md'));
  const docsMd = readdirSync(join(REPO_ROOT, 'docs'))
    .filter((f) => f.endsWith('.md') && !f.startsWith('handoff-archive-'))
    .map((f) => `docs/${f}`);
  return [...rootMd, ...docsMd];
}

const text = (rel: string): string => readFileSync(join(REPO_ROOT, rel), 'utf8');

const rootScripts = new Set(Object.keys(JSON.parse(text('package.json')).scripts as object));

/** pnpm 自带子命令，不是本仓 script */
const PNPM_BUILTIN = new Set([
  'add', 'audit', 'build', 'deploy', 'dlx', 'exec', 'fetch', 'import', 'init', 'install', 'link',
  'list', 'licenses', 'outdated', 'pack', 'patch', 'prune', 'publish', 'rebuild', 'remove',
  'run', 'store', 'test', 'typecheck', 'unlink', 'version', 'why', 'workspace', 'workspaces',
]);

/** pnpm 内置或文档里的占位写法，不作为 script 名校验 */
const SKIP_SCRIPT_WORDS = new Set(['exec', 'run', 'shell']);

function packageJsonOf(pkgName: string): { scripts?: Record<string, string> } | null {
  const short = pkgName.startsWith('@') ? pkgName.split('/')[1] ?? '' : pkgName;
  for (const base of ['packages', 'apps']) {
    const file = join(REPO_ROOT, base, short, 'package.json');
    if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8')) as { scripts?: Record<string, string> };
  }
  return null;
}

function collectCommandProblems(): string[] {
  const problems: string[] = [];
  for (const doc of operationalDocs()) {
    const body = text(doc);

    // 1) `pnpm <script>`（不带 --filter、非 flag）必须是根 script 或 pnpm 内置
    for (const match of body.matchAll(/pnpm\s+(?!-)([a-z][a-z0-9:-]*)/g)) {
      const name = match[1];
      if (!name || PNPM_BUILTIN.has(name) || rootScripts.has(name)) continue;
      problems.push(`${doc}: \`pnpm ${name}\` 在根 package.json 里不存在`);
    }

    // 2) `pnpm --filter <pkg> <script>` 的 script 必须在该包里定义
    for (const match of body.matchAll(/pnpm\s+--filter\s+([^\s<>]+)\s+([a-z][a-z0-9:-]*)/g)) {
      const pkg = match[1];
      const script = match[2];
      if (!pkg || !script) continue;
      if (!pkg.startsWith('@jobagent/')) continue; // 占位符（<pkg>）与其他 filter 形式跳过
      if (SKIP_SCRIPT_WORDS.has(script) || PNPM_BUILTIN.has(script)) continue;
      const pkgJson = packageJsonOf(pkg);
      if (!pkgJson) {
        problems.push(`${doc}: workspace 包 ${pkg} 不存在`);
        continue;
      }
      if (!(script in (pkgJson.scripts ?? {}))) {
        problems.push(`${doc}: \`pnpm --filter ${pkg} ${script}\` 该包没有这个 script`);
      }
    }

    // 3) tools/*.sh 必须存在
    for (const match of body.matchAll(/(?:bash\s+|\.\/|^\s*)(tools\/[a-z0-9._-]+\.sh)/gm)) {
      const file = match[1];
      if (file && !existsSync(join(REPO_ROOT, file))) problems.push(`${doc}: ${file} 不存在`);
    }

    // 4) 文档写到的 apps/<x>/dist/... 入口，其包必须在
    for (const match of body.matchAll(/\b(apps|packages)\/([a-z0-9-]+)\/dist\/[A-Za-z0-9._/-]+/g)) {
      const base = match[1];
      const name = match[2];
      if (!base || !name) continue;
      if (!existsSync(join(REPO_ROOT, base, name, 'package.json'))) {
        problems.push(`${doc}: ${base}/${name} 包不存在（文档里有 dist 路径）`);
      }
    }
  }
  return [...new Set(problems)].sort();
}

function commandMentions(): number {
  let count = 0;
  for (const doc of operationalDocs()) {
    const body = text(doc);
    count += [...body.matchAll(/pnpm\s+(?!-)[a-z][a-z0-9:-]*|pnpm\s+--filter\s+[^\s<>]+\s+[a-z][a-z0-9:-]*|(?:bash\s+|\.\/)tools\/[a-z0-9._-]+\.sh|\b(?:apps|packages)\/[a-z0-9-]+\/dist\/[A-Za-z0-9._/-]+/g)].length;
  }
  return count;
}

describe('documented commands are runnable', () => {
  it('only references scripts, tooling and package entries that exist', () => {
    expect(collectCommandProblems()).toEqual([]);
  });

  it('actually examines the command surface', () => {
    // 防守护空转：现行文档里至少有这么多条命令引用在被检查
    expect(operationalDocs().length).toBeGreaterThanOrEqual(25);
    expect(commandMentions()).toBeGreaterThanOrEqual(40);
  });
});
