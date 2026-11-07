#!/usr/bin/env node
/**
 * Vercel Ignored Build Step for the `apps/report` project.
 *
 * 退出码语义（Vercel）：0 = 跳过本次构建；1 = 继续构建。
 *
 * 只有以下变化才构建：
 * - apps/report 自身；
 * - apps/report 通过 workspace:* 直接/间接依赖的 packages；
 * - 影响安装/构建的根文件（锁文件、workspace 配置、tsconfig、本脚本）。
 *
 * 没有上一版本 SHA（首次部署 / 浅克隆缺历史）时一律构建，避免误跳过。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const ROOT_FILES = [
  'pnpm-lock.yaml',
  'package.json',
  'pnpm-workspace.yaml',
  'tsconfig.json',
  'tsconfig.base.json',
  'scripts/vercel-ignore-report.mjs',
];

/** 读取 workspace 内所有 package.json：包名 → 目录。 */
function workspacePackages(root) {
  const map = new Map();
  for (const group of ['apps', 'packages']) {
    const groupDir = join(root, group);
    if (!existsSync(groupDir)) continue;
    for (const entry of readdirSync(groupDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = join(groupDir, entry.name);
      const manifest = join(dir, 'package.json');
      if (!existsSync(manifest)) continue;
      const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
      if (typeof pkg.name === 'string') map.set(pkg.name, { dir, pkg });
    }
  }
  return map;
}

/** @jobagent/report 的 workspace 依赖闭包（含自身）+ 根级构建输入。 */
export function reportWatchPaths(root = repoRoot) {
  const packages = workspacePackages(root);
  const seen = new Set();
  const queue = [join(root, 'apps', 'report')];
  while (queue.length > 0) {
    const dir = queue.pop();
    if (seen.has(dir) || !existsSync(join(dir, 'package.json'))) continue;
    seen.add(dir);
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    for (const section of [
      'dependencies',
      'devDependencies',
      'optionalDependencies',
      'peerDependencies',
    ]) {
      for (const [name, spec] of Object.entries(pkg[section] ?? {})) {
        if (typeof spec !== 'string' || !spec.startsWith('workspace:')) continue;
        const dep = packages.get(name);
        if (dep) queue.push(dep.dir);
      }
    }
  }

  const paths = [...seen].map((dir) => relative(root, dir)).sort();
  for (const file of ROOT_FILES) {
    if (existsSync(join(root, file))) paths.push(file);
  }
  return paths;
}

/** 选定 diff 基线：优先 Vercel 提供的上一版本 SHA，其次 HEAD^。 */
function resolveBase(root) {
  const candidates = [];
  if (process.env.VERCEL_GIT_PREVIOUS_SHA) candidates.push(process.env.VERCEL_GIT_PREVIOUS_SHA);
  candidates.push('HEAD^');
  for (const ref of candidates) {
    try {
      execFileSync('git', ['-C', root, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
        stdio: 'ignore',
      });
      return ref;
    } catch {
      // 继续尝试下一个
    }
  }
  return undefined;
}

/** true = 需要构建（有相关变更或无法判断），false = 跳过。 */
export function shouldBuild(root = repoRoot, base = resolveBase(root)) {
  if (!base) return true;
  try {
    execFileSync('git', ['-C', root, 'diff', '--quiet', base, 'HEAD', '--', ...reportWatchPaths(root)], {
      stdio: 'ignore',
    });
    return false;
  } catch {
    return true;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const base = resolveBase(repoRoot);
  const build = shouldBuild(repoRoot, base);
  console.log(`[vercel-ignore-report] base=${base ?? 'none'} build=${build}`);
  process.exit(build ? 1 : 0);
}
