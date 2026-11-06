#!/usr/bin/env node
/**
 * Static guards for the dev -> main release window. Nothing here touches the
 * network or a database; the goal is to fail before a merge/deploy when the
 * repository contradicts the documented release preconditions:
 *
 * 1. Both SQL dialects ship migrations 042 (hub projection) and 043
 *    (profile_events audit) — production runs DB_AUTO_MIGRATE=false, so the
 *    DDL must already be applied and the files must exist in the repo.
 * 2. The Node version is identical in .nvmrc, root package.json engines and
 *    every `FROM node:<version>` Dockerfile stage (engine-strict=true makes a
 *    mismatch a hard install failure).
 * 3. The hard-required production env vars are documented in .env.example and
 *    in the handoff §5 table, so a deploy cannot silently miss one.
 * 4. No workspace package depends on the model-hub source tree; model-kit must
 *    stay a committed vendor tarball because Vercel clones this repo alone.
 *
 * Usage: node scripts/check-release-readiness.mjs [root]
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(
  process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..'),
);

const REQUIRED_MIGRATION_PREFIXES = ['042', '043'];
const DIALECTS = ['sqlite', 'postgres'];
const REQUIRED_ENV_VARS = [
  'DB_DRIVER',
  'DATABASE_URL',
  'DB_AUTO_MIGRATE',
  'API_MOUNT_PREFIX',
  'CRON_SECRET',
  'TRUST_PROXY',
];
const DEPENDENCY_SECTIONS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
];

const problems = [];

function readText(relPath) {
  const fullPath = path.join(repoRoot, relPath);
  if (!existsSync(fullPath)) {
    problems.push(`${relPath} is missing`);
    return null;
  }
  return readFileSync(fullPath, 'utf8');
}

function normalizeVersion(value) {
  return value.trim().replace(/^v/, '');
}

// 1. Migrations in both dialects.
for (const dialect of DIALECTS) {
  const dir = path.join(repoRoot, 'db', 'migrations', dialect);
  if (!existsSync(dir)) {
    problems.push(`db/migrations/${dialect} is missing`);
    continue;
  }
  const files = readdirSync(dir).filter((name) => name.endsWith('.sql'));
  for (const prefix of REQUIRED_MIGRATION_PREFIXES) {
    if (!files.some((name) => name.startsWith(`${prefix}_`))) {
      problems.push(`db/migrations/${dialect} has no ${prefix}_*.sql migration`);
    }
  }
}

// 2. Node version alignment.
const nvmrcVersion = normalizeVersion(readText('.nvmrc') ?? '');
if (!/^\d+\.\d+\.\d+$/.test(nvmrcVersion)) {
  problems.push(`.nvmrc must contain a full version (found "${nvmrcVersion}")`);
}

const rootManifestText = readText('package.json');
if (rootManifestText) {
  let rootManifest;
  try {
    rootManifest = JSON.parse(rootManifestText);
  } catch {
    problems.push('package.json is not valid JSON');
  }
  const engineRange = rootManifest?.engines?.node;
  if (typeof engineRange !== 'string') {
    problems.push('package.json engines.node is missing');
  } else {
    const engineVersion = engineRange.match(/\d+\.\d+\.\d+/)?.[0];
    if (engineVersion !== nvmrcVersion) {
      problems.push(
        `package.json engines.node "${engineRange}" does not match .nvmrc ${nvmrcVersion}`,
      );
    }
  }
}

const dockerfile = readText('Dockerfile');
if (dockerfile !== null) {
  const dockerVersions = dockerfile
    .split('\n')
    .map((line, index) => ({ line: index + 1, match: /^FROM\s+node:(\S+)/.exec(line.trim()) }))
    .filter(({ match }) => match)
    .map(({ line, match }) => ({ line, version: normalizeVersion(match[1].split('-')[0]) }));
  if (dockerVersions.length === 0) {
    problems.push('Dockerfile has no `FROM node:<version>` stage');
  }
  for (const { line, version } of dockerVersions) {
    if (version !== nvmrcVersion) {
      problems.push(
        `Dockerfile:${line} uses Node ${version}, but .nvmrc pins ${nvmrcVersion}`,
      );
    }
  }
}

// 3. Hard-required production env vars documented in both places.
const envExample = readText('.env.example');
if (envExample !== null) {
  for (const name of REQUIRED_ENV_VARS) {
    if (!new RegExp(`^${name}=`, 'm').test(envExample)) {
      problems.push(`.env.example has no "${name}=" entry`);
    }
  }
}

const handoff = readText('handoff.md');
if (handoff !== null) {
  for (const name of REQUIRED_ENV_VARS) {
    if (!handoff.includes(`| \`${name}`)) {
      problems.push(`handoff.md §5 table has no row documenting \`${name}\``);
    }
  }
}

// 4. No model-hub source dependency anywhere in the workspace.
const manifests = [path.join(repoRoot, 'package.json')];
for (const dirName of ['apps', 'packages']) {
  const workspaceDir = path.join(repoRoot, dirName);
  if (!existsSync(workspaceDir)) continue;
  for (const entry of readdirSync(workspaceDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = path.join(workspaceDir, entry.name, 'package.json');
    if (existsSync(manifestPath)) manifests.push(manifestPath);
  }
}

for (const manifestPath of manifests) {
  const relPath = path.relative(repoRoot, manifestPath).split(path.sep).join('/');
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    problems.push(`${relPath} is not valid JSON`);
    continue;
  }
  for (const section of DEPENDENCY_SECTIONS) {
    const deps = manifest[section];
    if (!deps || typeof deps !== 'object') continue;
    for (const [dep, spec] of Object.entries(deps)) {
      if (typeof spec !== 'string') continue;
      const pointsAtSource =
        spec.includes('model-hub/packages') || /^(file|link):.*\/model-hub(?:\/|$)/.test(spec);
      if (pointsAtSource && !spec.includes('/vendor/')) {
        problems.push(
          `${relPath} ${section}["${dep}"] depends on model-hub source "${spec}"; ` +
            'commit a vendor tarball instead (Vercel clones this repo alone)',
        );
      }
    }
  }
}

if (problems.length > 0) {
  console.error(`[fail] release readiness checks failed:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  process.exit(1);
}

console.log(
  `OK: release readiness checks passed (Node ${nvmrcVersion}, migrations ` +
    `${REQUIRED_MIGRATION_PREFIXES.join('/')} in both dialects, ${REQUIRED_ENV_VARS.length} hard ` +
    'env vars documented, no model-hub source dependencies).',
);
