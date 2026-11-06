#!/usr/bin/env node
/**
 * Verify that vendor/model-hub-model-kit-<version>.tgz still matches the
 * model-hub source we depend on.
 *
 * - Repacks model-kit from model-hub/packages/model-kit (npm pack runs the
 *   package's prepare step, so dist is rebuilt first).
 * - Compares extracted file contents, not tarball bytes: gzip metadata and
 *   file mtimes are not reproducible, but the packed files are.
 * - When the model-hub checkout or its build toolchain is unavailable the
 *   check prints an explicit skip and exits 0; CI installs the toolchain so
 *   a stale vendored tarball cannot pass there.
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vendorDir = path.join(repoRoot, 'vendor');
const modelHubDir = process.env.MODEL_HUB_DIR ?? path.join(repoRoot, 'model-hub');
const kitDir = path.join(modelHubDir, 'packages', 'model-kit');

function fail(message) {
  console.error(message);
  process.exit(1);
}

function skip(message) {
  console.log(message);
  process.exit(0);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.error) fail(`${command} failed to start: ${result.error.message}`);
  return result;
}

function walkFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkFiles(full));
    } else if (entry.isFile()) {
      files.push(full);
    }
  }
  return files;
}

function fileDigests(packageRoot) {
  const map = new Map();
  for (const file of walkFiles(packageRoot)) {
    const rel = path.relative(packageRoot, file).split(path.sep).join('/');
    map.set(rel, createHash('sha256').update(readFileSync(file)).digest('hex'));
  }
  return map;
}

function aggregateDigest(map) {
  const hash = createHash('sha256');
  for (const rel of [...map.keys()].sort()) {
    hash.update(`${rel}\0${map.get(rel)}\n`);
  }
  return hash.digest('hex');
}

function extract(tarball, destination) {
  mkdirSync(destination, { recursive: true });
  const result = run('tar', ['-xzf', tarball, '-C', destination]);
  if (result.status !== 0) fail(`tar -xzf ${tarball} failed:\n${result.stderr}`);
}

if (!existsSync(path.join(kitDir, 'package.json'))) {
  skip(
    `[skip] model-hub source not found at ${kitDir}. ` +
      'Set MODEL_HUB_DIR or clone bayernjf/model-hub into the workspace to verify freshness.',
  );
}

const sourcePackage = JSON.parse(readFileSync(path.join(kitDir, 'package.json'), 'utf8'));
const expectedName = `model-hub-model-kit-${sourcePackage.version}.tgz`;

if (!existsSync(vendorDir)) {
  fail(`[fail] vendor directory is missing; expected ${expectedName}.`);
}

const vendored = readdirSync(vendorDir).filter((name) =>
  /^model-hub-model-kit-.*\.tgz$/.test(name),
);
if (vendored.length !== 1) {
  fail(
    `[fail] expected exactly one vendored model-kit tarball in vendor/, found ${vendored.length}: ` +
      `${vendored.join(', ') || '(none)'}.`,
  );
}
if (vendored[0] !== expectedName) {
  fail(
    `[fail] vendored tarball does not match model-kit version ${sourcePackage.version}: ` +
      `found ${vendored[0]}, expected ${expectedName}. Repack and update package.json plus the lockfile.`,
  );
}

const hasTypeScript = [
  path.join(kitDir, 'node_modules', 'typescript'),
  path.join(modelHubDir, 'node_modules', 'typescript'),
  path.join(kitDir, 'node_modules', '.bin', 'tsc'),
  path.join(modelHubDir, 'node_modules', '.bin', 'tsc'),
].some((candidate) => existsSync(candidate));

if (!hasTypeScript) {
  skip(
    `[skip] typescript is not installed for ${kitDir}, so the vendored tarball cannot be rebuilt. ` +
      'Run `npm install --workspaces=false --no-audit --no-fund` there (CI does this) and rerun.',
  );
}

const workDir = mkdtempSync(path.join(tmpdir(), 'model-kit-vendor-'));
try {
  const pack = run('npm', ['pack', '--pack-destination', workDir], { cwd: kitDir });
  if (pack.status !== 0) {
    fail(`[fail] npm pack failed in ${kitDir}:\n${pack.stdout}\n${pack.stderr}`);
  }
  const packedName = pack.stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .pop();
  const freshTarball = path.join(workDir, packedName);
  if (!existsSync(freshTarball)) {
    fail(`[fail] npm pack reported ${packedName} but it does not exist in ${workDir}.`);
  }

  const freshDir = path.join(workDir, 'fresh');
  const vendoredDir = path.join(workDir, 'vendored');
  extract(freshTarball, freshDir);
  extract(path.join(vendorDir, vendored[0]), vendoredDir);

  const fresh = fileDigests(path.join(freshDir, 'package'));
  const current = fileDigests(path.join(vendoredDir, 'package'));

  const added = [...fresh.keys()].filter((rel) => !current.has(rel));
  const removed = [...current.keys()].filter((rel) => !fresh.has(rel));
  const changed = [...fresh.keys()].filter(
    (rel) => current.has(rel) && current.get(rel) !== fresh.get(rel),
  );

  if (added.length || removed.length || changed.length) {
    const limit = 20;
    const lines = [];
    if (added.length) lines.push(`  + ${added.slice(0, limit).join('\n  + ')}`);
    if (removed.length) lines.push(`  - ${removed.slice(0, limit).join('\n  - ')}`);
    if (changed.length) lines.push(`  ~ ${changed.slice(0, limit).join('\n  ~ ')}`);
    fail(
      `[fail] ${vendored[0]} is stale versus ${kitDir}.\n` +
        `Files differ:\n${lines.join('\n')}\n` +
        'Rebuild and repack into vendor/, then update apps/api/package.json and pnpm-lock.yaml.',
    );
  }

  console.log(
    `[ok] ${vendored[0]} matches model-hub/packages/model-kit (${fresh.size} files, ` +
      `digest ${aggregateDigest(fresh).slice(0, 16)}).`,
  );
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
