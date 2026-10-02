#!/usr/bin/env node
/**
 * Release packaging for the Chrome extension (Chrome Web Store upload artifact).
 *
 * Runs the CWS release build (EXTENSION_RELEASE=1, which strips every localhost
 * grant and refuses to bake a localhost API endpoint) and then zips dist/ with
 * manifest.json at the archive root — the layout the CWS upload form requires.
 *
 * Required env:
 *   EXTENSION_API_BASE    Production same-origin API URL, e.g.
 *                         https://app.job-agent.bayjf.com/api
 * Optional env:
 *   EXTENSION_SITE_ORIGIN Production report-site origin. build.mjs defaults to
 *                         https://app.job-agent.bayjf.com (the production
 *                         report origin); override only when the domain changes.
 *
 * Usage:
 *   EXTENSION_API_BASE=https://app.example.com/api \
 *   EXTENSION_SITE_ORIGIN=https://app.example.com \
 *     node scripts/release.mjs [--force]
 *
 * Output: release/jobagent-extension-v<version>.zip (gitignored, never committed).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const extRoot = path.resolve(here, '..');
const distDir = path.join(extRoot, 'dist');
const outDir = path.join(extRoot, 'release');
const pkg = JSON.parse(readFileSync(path.join(extRoot, 'package.json'), 'utf8'));

const force = process.argv.includes('--force');
const apiBase = process.env.EXTENSION_API_BASE;
const siteOrigin = process.env.EXTENSION_SITE_ORIGIN;

function fail(message) {
  console.error(`[release] ${message}`);
  process.exit(1);
}

const isLocal = (value) => /^https?:\/\/(localhost|127\.0\.0\.1)/.test(value);

if (!apiBase || !/^https:\/\//.test(apiBase) || isLocal(apiBase)) {
  fail(
    'EXTENSION_API_BASE must be set to the production https API URL ' +
      '(e.g. https://app.job-agent.bayjf.com/api). localhost is refused for CWS releases.',
  );
}
if (!siteOrigin) {
  console.warn(
    '[release] EXTENSION_SITE_ORIGIN not set; using the default production ' +
      'report origin https://app.job-agent.bayjf.com.',
  );
} else if (!/^https:\/\//.test(siteOrigin) || isLocal(siteOrigin)) {
  fail('EXTENSION_SITE_ORIGIN must be a public https origin.');
}

// 1. Release build (build.mjs enforces the same invariants itself).
const buildEnv = {
  ...process.env,
  EXTENSION_RELEASE: '1',
  EXTENSION_API_BASE: apiBase,
};
if (siteOrigin) buildEnv.EXTENSION_SITE_ORIGIN = siteOrigin;
const build = spawnSync(process.execPath, [path.join(extRoot, 'build.mjs')], {
  cwd: extRoot,
  stdio: 'inherit',
  env: buildEnv,
});
if (build.status !== 0) fail('release build failed.');

// 2. Assert the release bundle contains no localhost/127.0.0.1 strings anywhere
//    (defense in depth; build.mjs already filters manifest grants, but a CWS zip
//    with localhost — e.g. in i18n placeholder text — is a review blocker and is
//    unrecoverable once submitted).
const manifestPath = path.join(distDir, 'manifest.json');
if (!existsSync(manifestPath)) fail(`dist/manifest.json not found after build at ${manifestPath}.`);
const textExts = new Set(['.js', '.json', '.html', '.css']);
const localMatches = [];
for (const name of readdirSync(distDir)) {
  const ext = path.extname(name);
  if (!textExts.has(ext)) continue;
  const lines = readFileSync(path.join(distDir, name), 'utf8').split('\n');
  lines.forEach((line, i) => {
    if (/(localhost|127\.0\.0\.1)/.test(line)) {
      localMatches.push(`${name}:${i + 1}: ${line.trim().slice(0, 120)}`);
    }
  });
}
if (localMatches.length > 0) {
  fail('release bundle still contains localhost/127.0.0.1 strings:\n' + localMatches.join('\n'));
}

// 3. Zip with manifest.json at the archive root (CWS requirement: no dist/ prefix).
mkdirSync(outDir, { recursive: true });
const zipName = `jobagent-extension-v${pkg.version}.zip`;
const zipPath = path.join(outDir, zipName);
if (existsSync(zipPath) && !force) {
  fail(`${zipName} already exists in release/. Re-run with --force to replace it.`);
}
if (existsSync(zipPath)) rmSync(zipPath);

let zip;
if (process.platform === 'win32') {
  // Windows: PowerShell Compress-Archive. "-Path *" places the dist contents at
  // the archive root instead of nesting them under a dist/ folder.
  zip = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-Command', `Compress-Archive -Path * -DestinationPath '${zipPath}' -Force`],
    { cwd: distDir, stdio: 'inherit' },
  );
} else {
  // macOS/Linux: system zip. -X drops extra attributes; "." keeps the root flat.
  zip = spawnSync('zip', ['-r', '-X', '-q', zipPath, '.'], {
    cwd: distDir,
    stdio: 'inherit',
  });
}
if (zip.status !== 0) {
  fail('zipping dist/ failed (macOS/Linux need the system zip command; Windows needs PowerShell).');
}

console.log(`[release] packaged ${path.relative(extRoot, zipPath)} (version ${pkg.version})`);
console.log('[release] verify layout: unzip -l release/' + zipName + '   # manifest.json at root');
