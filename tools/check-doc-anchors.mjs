#!/usr/bin/env node
/**
 * 文档锚点体检：断言 markdown 里写出的 `path.ext:<line>` / `<line>-<line>` 能解析到
 * 真实存在的行，防止"文档指向一个已经不存在的行号"这种静默腐烂。
 *
 * 为什么需要它：仓库已有四条文档守护（路由名 / env / 链接可达 / 命令可跑），
 * 但没有一条看行号。2026-10-03 把 apps/api/src/index.ts 从 2691 行拆成 275 行 +
 * routes/* 之后，两份核心文档里 19 处证据锚点当场失效而全部门禁仍绿。
 *
 * 用法：
 *   node tools/check-doc-anchors.cjs                # 扫描默认范围，违例则 exit 1
 *   node tools/check-doc-anchors.cjs <file.md> ...   # 只查指定文件（打印明细）
 */
import fs from 'node:fs';
import path from 'node:path';

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  '.astro',
  '.vercel',
  '.next',
  'build',
  'coverage',
  'test-results',
]);

/**
 * 归档与"某日评审"是**时间点记录**（AGENTS §0：归档文件冻结只读；评审正文按惯例不回改），
 * 其中的行号描述的是当天的代码，回改等于篡改历史，因此排除在断言范围外。
 * 受约束的是活文档：AGENTS、README、handoff、docs 下的 API 文档、PRD、design 系列、
 * deferred 登记表与本审计报告。
 */
const EXCLUDED = [/^docs\/handoff-archive-/, /^docs\/评审-MVP-/];

const REF_RE = /([A-Za-z0-9_@./-]+\.(?:ts|tsx|astro|mts|cts|js|json|sql|ya?ml|css|md|sh|py)):(\d+)(?:-(\d+))?/g;

function listMarkdown(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(process.cwd(), full);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) listMarkdown(full, out);
    } else if (entry.name.endsWith('.md')) {
      out.push(rel);
    }
  }
  return out;
}

const lineCountCache = new Map();
function lineCount(file) {
  if (!lineCountCache.has(file)) {
    try {
      lineCountCache.set(file, fs.readFileSync(file, 'utf8').split('\n').length);
    } catch {
      lineCountCache.set(file, -1);
    }
  }
  return lineCountCache.get(file);
}

/** 仓库内 basename -> 路径列表，用于把裸文件名引用解析成真实文件 */
const byBasename = new Map();
function indexSources(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) indexSources(full);
    } else if (entry.name.includes('.') && !entry.name.endsWith('.md')) {
      if (!byBasename.has(entry.name)) byBasename.set(entry.name, []);
      byBasename.get(entry.name).push(full);
    }
  }
}
indexSources('.');

function resolve(spec) {
  const direct = lineCount(spec);
  if (direct > 0) return [spec];
  const cands = byBasename.get(path.basename(spec)) ?? [];
  const tail = spec.replace(/^\.\//, '');
  const narrowed = cands.filter((c) => c.endsWith(tail));
  return narrowed.length ? narrowed : cands;
}

const args = process.argv.slice(2);
const explicit = args.length > 0;
const targets = explicit ? args : listMarkdown('.').filter((f) => !EXCLUDED.some((re) => re.test(f)));

const violations = [];
let checked = 0;
for (const doc of targets) {
  const text = fs.readFileSync(doc, 'utf8');
  for (const m of text.matchAll(REF_RE)) {
    const [, spec, from, to] = m;
    const end = Number(to ?? from);
    checked += 1;
    const cands = resolve(spec);
    if (cands.length === 0) {
      violations.push(`${doc}: 引用不存在的文件 ${spec}:${from}`);
      continue;
    }
    // 同名多文件时，只要任一个候选文件能容纳该行号即视为可解析（歧义不判红，交人工写全路径）
    if (!cands.some((c) => end <= lineCount(c))) {
      const sizes = cands.map((c) => `${c}(${lineCount(c)} 行)`).join(', ');
      violations.push(`${doc}: ${spec}:${from}${to ? `-${to}` : ''} 越界 — 候选 ${sizes}`);
    }
  }
}

if (explicit) {
  console.log(`${targets.join(' ')}：引用 ${checked} 处，违例 ${violations.length} 处`);
} else {
  console.log(
    `[check-doc-anchors] 扫描 ${targets.length} 个 markdown（排除归档 ${EXCLUDED.length} 条规则），引用 ${checked} 处，违例 ${violations.length} 处`,
  );
}
for (const v of violations) console.log('  - ' + v);
process.exit(violations.length > 0 ? 1 : 0);
