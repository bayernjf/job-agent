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
 *                         the placeholder https://job-agent.bayjf.com; the real
 *                         production origin MUST be set before publishing.
 *
 * Usage:
 *   EXTENSION_API_BASE=https://app.example.com/api \
 *   EXTENSION_SITE_ORIGIN=https://app.example.com \
 *     node scripts/release.mjs [--force]
 *
 * Output: release/jobagent-extension-v<version>.zip (gitignored, never committed).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
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
    '[release] EXTENSION_SITE_ORIGIN not set; build.mjs keeps the placeholder ' +
      'https://job-agent.bayjf.com. Set the real production origin before publishing.',
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

// 2. Assert the baked manifest contains no local grants (defense in depth;
//    build.mjs already filters them, but a CWS zip with localhost is unrecoverable).
const manifestPath = path.join(distDir, 'manifest.json');
if (!existsSync(manifestPath)) fail(`dist/manifest.json not found after build at ${manifestPath}.`);
const manifestText = readFileSync(manifestPath, 'utf8');
if (/(localhost|127\.0\.0\.1)/.test(manifestText)) {
  fail('dist/manifest.json still contains a localhost/127.0.0.1 entry:\n' + manifestText);
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
