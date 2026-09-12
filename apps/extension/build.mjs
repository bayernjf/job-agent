#!/usr/bin/env node
/**
 * Build the Chrome extension (Manifest V3) with esbuild.
 * Produces dist/ ready to load unpacked in chrome://extensions.
 *
 *   node build.mjs                # dev build (unminified)
 *   EXTENSION_API_BASE=... node build.mjs   # override default API base baked into content script
 */
import { build } from 'esbuild';
import { cp, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const outdir = path.join(root, 'dist');
const apiBase = process.env.EXTENSION_API_BASE ?? 'http://localhost:3000';

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
await cp(path.join(root, 'src/manifest.json'), path.join(outdir, 'manifest.json'));
await cp(path.join(root, 'src/content/panel.css'), path.join(outdir, 'panel.css'));
await cp(path.join(root, 'src/icons/icon16.png'), path.join(outdir, 'icon16.png'));
await cp(path.join(root, 'src/icons/icon48.png'), path.join(outdir, 'icon48.png'));
await cp(path.join(root, 'src/icons/icon128.png'), path.join(outdir, 'icon128.png'));

console.log(`Extension built to ${outdir} (api base: ${apiBase})`);
