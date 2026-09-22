#!/usr/bin/env node
/**
 * Build the Chrome extension (Manifest V3) with esbuild.
 * Produces dist/ ready to load unpacked in chrome://extensions.
 *
 *   node build.mjs                # dev build (unminified, localhost grants)
 *   EXTENSION_API_BASE=... node build.mjs   # override default API base baked into content script
 *
 *   # CWS release build (fails on localhost API/site, strips localhost grants):
 *   EXTENSION_RELEASE=1 EXTENSION_API_BASE=https://<app-origin>/api \
 *     EXTENSION_SITE_ORIGIN=https://<app-origin> node build.mjs
 */
import { build } from 'esbuild';
import { cp, mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const outdir = path.join(root, 'dist');
const apiBase = process.env.EXTENSION_API_BASE ?? 'http://localhost:3000';
// Release build (CWS): EXTENSION_RELEASE=1 strips every localhost/127.0.0.1
// grant and bakes the final report-site origin (set EXTENSION_SITE_ORIGIN to
// the decided production domain; defaults to the current placeholder).
const release = process.env.EXTENSION_RELEASE === '1';
const siteOrigin = process.env.EXTENSION_SITE_ORIGIN ?? 'https://job-agent.bayjf.com';

if (release && /^https?:\/\/(localhost|127\.0\.0\.1)/.test(apiBase)) {
  console.error(
    '[build] EXTENSION_RELEASE=1 requires a production EXTENSION_API_BASE; refusing to ship a localhost API endpoint.',
  );
  process.exit(1);
}
if (release && /^https?:\/\/(localhost|127\.0\.0\.1)/.test(siteOrigin)) {
  console.error('[build] EXTENSION_SITE_ORIGIN must be a public https origin for release builds.');
  process.exit(1);
}

/**
 * Manifest transform for the dist copy.
 * Dev keeps localhost grants; release removes them and pins the site origin.
 */
async function emitManifest() {
  const src = JSON.parse(await readFile(path.join(root, 'src/manifest.json'), 'utf8'));
  const manifest = structuredClone(src);
  const isLocal = (m) => /^https?:\/\/(localhost|127\.0\.0\.1)/.test(m);
  const isPlaceholderSite = (m) => /^https?:\/\/[^/]*job-agent\.bayjf\.com/.test(m);

  manifest.externally_connectable.matches = manifest.externally_connectable.matches
    .filter((m) => !(release && isLocal(m)))
    .map((m) => (isPlaceholderSite(m) ? `${siteOrigin}/*` : m));
  manifest.host_permissions = manifest.host_permissions
    .filter((m) => !(release && isLocal(m)))
    .map((m) => (isPlaceholderSite(m) ? `${siteOrigin}/*` : m));

  await writeFile(path.join(outdir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
}

await mkdir(outdir, { recursive: true });

const define = { EXTENSION_API_BASE: JSON.stringify(apiBase) };

// Content script: injected into ATS pages, renders the floating button + fill panel.
// Bundled as a single IIFE (React inlined) because MV3 content scripts cannot use ES modules.
await build({
  entryPoints: [path.join(root, 'src/content/index.tsx')],
  outfile: path.join(outdir, 'content.js'),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['chrome120'],
  jsx: 'automatic',
  define,
  minify: true,
  sourcemap: false,
  logLevel: 'info',
});

// Background service worker (ES module per MV3).
await build({
  entryPoints: [path.join(root, 'src/background/index.ts')],
  outfile: path.join(outdir, 'background.js'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['chrome120'],
  define,
  minify: true,
  sourcemap: false,
  logLevel: 'info',
});

// Static assets.
// Manifest is emitted via emitManifest(): dev keeps localhost grants, release
// (EXTENSION_RELEASE=1) strips them and pins EXTENSION_SITE_ORIGIN.
await emitManifest();
await cp(path.join(root, 'src/content/panel.css'), path.join(outdir, 'panel.css'));
// Shared design tokens (single source in packages/ui-tokens), loaded inside the shadow root before panel.css
await cp(
  path.join(root, 'node_modules/@jobagent/ui-tokens/tokens.css'),
  path.join(outdir, 'tokens.css'),
);
// Chrome native i18n bundles (manifest __MSG_*__), en + zh_CN
await cp(path.join(root, '_locales'), path.join(outdir, '_locales'), { recursive: true });
await cp(path.join(root, 'src/icons/icon16.png'), path.join(outdir, 'icon16.png'));
await cp(path.join(root, 'src/icons/icon48.png'), path.join(outdir, 'icon48.png'));
await cp(path.join(root, 'src/icons/icon128.png'), path.join(outdir, 'icon128.png'));

console.log(`Extension built to ${outdir} (api base: ${apiBase})`);
