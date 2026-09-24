/**
 * 环境变量四处一致性守护：代码读取点 ↔ `.env.example` ↔ `docs/API.md` 环境变量表
 * ↔ 形态 C 部署执行单的 Vercel env 总表。
 *
 * 路由面已有 api-doc-consistency.test.ts 双向守护，env 面此前只靠人工对齐：
 * 漏配 `API_MOUNT_PREFIX` 会让生产 OAuth 回调 404（真实踩过，见
 * docs/handoff-archive-2026-09-20.md §3），文档里的默认值也会随拍板漂移
 * （`DEMO_SESSION_TTL_MS` 曾长期写着已废弃的 7 天）。这里把 key 集合与
 * 可机读的数值默认值钉成测试，只读文件、零副作用、不打网络。
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { DEMO_DEFAULTS } from './demo-config.js';

const REPO_ROOT = resolve(__dirname, '../../..');
const read = (rel: string): string => readFileSync(join(REPO_ROOT, rel), 'utf8');

/**
 * 扫描范围＝产品运行时代码 + 构建期注入点。
 * 刻意不含 dev-only 脚本（如 apps/extension/store-assets/capture.mjs），
 * 那些局部变量在各自 README 里说明，不属于部署配置面。
 */
const SCAN_DIRS = [
  'apps/api/src',
  'apps/worker/src',
  'apps/cli/src',
  'apps/report/src',
  'apps/extension/src',
  ...readdirSync(join(REPO_ROOT, 'packages'))
    .map((name) => `packages/${name}/src`)
    .filter((rel) => statSync(join(REPO_ROOT, rel), { throwIfNoEntry: false })?.isDirectory()),
];
const SCAN_FILES = [
  'apps/extension/build.mjs',
  'apps/extension/scripts/release.mjs',
  'apps/report/astro.config.mjs',
];
const SCAN_EXTENSIONS = new Set(['.ts', '.tsx', '.mjs', '.cjs', '.astro']);
const SKIP_DIRS = new Set(['node_modules', 'dist', '.vercel', 'release', 'test-results', 'playwright-report']);

function collectFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) collectFiles(full, out);
    else if (SCAN_EXTENSIONS.has(extname(full))) out.push(full);
  }
  return out;
}

/** `process.env.X` / `import.meta.env.X` / `importMetaEnv?.X` / 配置加载器的 `env.X` */
const ENV_READ = /\w*[Ee]nv\??\.([A-Z][A-Z0-9_]{2,})/g;
const ENV_READ_BRACKET = /\w*[Ee]nv\[['"]([A-Z][A-Z0-9_]{2,})['"]\]/g;

function codeEnvKeys(): Set<string> {
  const files = [
    ...SCAN_DIRS.flatMap((rel) => collectFiles(join(REPO_ROOT, rel))),
    ...SCAN_FILES.map((rel) => join(REPO_ROOT, rel)),
  ];
  const keys = new Set<string>();
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    for (const re of [ENV_READ, ENV_READ_BRACKET]) {
      re.lastIndex = 0;
      for (const match of source.matchAll(re)) {
        if (match[1]) keys.add(match[1]);
      }
    }
  }
  return keys;
}

/** 平台/运行时注入，不是本项目可配置项，故不进 .env.example */
const RUNTIME_INFRA_KEYS = new Set([
  'NODE_ENV', // 运行模式标志，由平台/启动命令注入
  'VERCEL', // Vercel 构建环境自带，用于切换 Astro 适配器
  'HTTP_PROXY', // 标准代理变量；.env.example 在 JOB_HTTP_PROXY 注释里说明回退顺序
  'HTTPS_PROXY',
]);

function templateKeys(): Set<string> {
  const keys = new Set<string>();
  for (const match of read('.env.example').matchAll(/^([A-Z][A-Z0-9_]*)=/gm)) {
    if (match[1]) keys.add(match[1]);
  }
  return keys;
}

/** docs/API.md「环境变量」小节全文（表格 + 表下补充说明） */
function apiDocEnvSection(): string {
  const doc = read('docs/API.md');
  const start = doc.indexOf('### 环境变量');
  expect(start).toBeGreaterThan(-1);
  const end = doc.indexOf('\n---', start);
  expect(end).toBeGreaterThan(start);
  return doc.slice(start, end);
}

function backtickedKeys(text: string): Set<string> {
  const keys = new Set<string>();
  for (const match of text.matchAll(/`([A-Z][A-Z0-9_]{2,})`/g)) {
    if (match[1]) keys.add(match[1]);
  }
  return keys;
}

/** 部署执行单 E3「Vercel Production env 总表」的 key 列 */
function deployChecklistEnvKeys(): Set<string> {
  const doc = read('docs/部署执行单-形态C-20260921.md');
  const header = doc.indexOf('| Key | Value |');
  expect(header).toBeGreaterThan(-1);
  const keys = new Set<string>();
  for (const line of doc.slice(header).split('\n').slice(2)) {
    if (!line.startsWith('|')) break;
    for (const key of backtickedKeys(line)) keys.add(key);
  }
  expect(keys.size).toBeGreaterThan(5);
  return keys;
}

/** 从 demo-config 加载器里读出「环境变量名 → DEMO_DEFAULTS 字段」映射，避免在测试里再抄一份 */
function demoDefaultMapping(): Array<{ key: string; value: number }> {
  const source = read('apps/api/src/demo-config.ts');
  const out: Array<{ key: string; value: number }> = [];
  const re = /positiveInt\(\s*env\.([A-Z][A-Z0-9_]+),\s*DEMO_DEFAULTS\.(\w+)/g;
  for (const match of source.matchAll(re)) {
    const key = match[1];
    const field = match[2] as keyof typeof DEMO_DEFAULTS | undefined;
    if (!key || !field) continue;
    const value = DEMO_DEFAULTS[field];
    if (typeof value === 'number') out.push({ key, value });
  }
  expect(out.length).toBeGreaterThan(3);
  return out;
}

describe('environment variable consistency', () => {
  it('documents every env key the code reads in .env.example', () => {
    const undocumented = [...codeEnvKeys()]
      .filter((key) => !RUNTIME_INFRA_KEYS.has(key) && !templateKeys().has(key))
      .sort();
    expect(undocumented).toEqual([]);
  });

  it('has no .env.example entry that the code stopped reading', () => {
    const readKeys = codeEnvKeys();
    const orphaned = [...templateKeys()].filter((key) => !readKeys.has(key)).sort();
    expect(orphaned).toEqual([]);
  });

  it('documents only env keys the code really reads in docs/API.md', () => {
    const readKeys = codeEnvKeys();
    const stale = [...backtickedKeys(apiDocEnvSection())]
      .filter((key) => !readKeys.has(key))
      .sort();
    expect(stale).toEqual([]);
  });

  it('lists every form C production env key in .env.example', () => {
    const template = templateKeys();
    const missing = [...deployChecklistEnvKeys()].filter((key) => !template.has(key)).sort();
    expect(missing).toEqual([]);
  });

  it('keeps docs/API.md demo defaults equal to DEMO_DEFAULTS', () => {
    const section = apiDocEnvSection();
    const drifted: string[] = [];
    let compared = 0;
    for (const { key, value } of demoDefaultMapping()) {
      const row = section.match(new RegExp(`^\\| \`${key}\` \\| ([^|]*)\\|`, 'm'));
      if (!row?.[1]) continue; // 表下补充说明里的变量不在表格内，跳过
      compared += 1;
      if (!row[1].includes(String(value))) drifted.push(`${key}: doc says "${row[1].trim()}", code default ${value}`);
    }
    // 防守护空转：表格里至少要比到 5 个演示模式默认值
    expect(compared).toBeGreaterThanOrEqual(5);
    expect(drifted).toEqual([]);
  });
});
