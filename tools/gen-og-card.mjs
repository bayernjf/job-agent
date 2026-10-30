#!/usr/bin/env node
/**
 * gen-og-card.mjs——生成报告页静态 OG 品牌卡（design-share-proof-card-20261030 §1.2）。
 *
 * 用法：node tools/gen-og-card.mjs   （需先 pnpm exec playwright install chromium）
 * 输出：apps/report/public/og-card.png（1200×630）
 *
 * 设计约束：
 * - 卡面只用英文（headless 环境的 CJK 字体不可控；动态文案走 og:title/og:description）。
 * - 色值取自 packages/ui-tokens/tokens.css（:root 浅色档），下方常量与 token 一一对应，
 *   改 token 后重跑本脚本即可再生成。
 * - 用 Playwright chromium 渲染 SVG 后截图——仓库既有依赖，不新增包。
 */
import { chromium } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const outPath = join(here, '..', 'apps', 'report', 'public', 'og-card.png');

// ---- 色值（来源：packages/ui-tokens/tokens.css 浅色 :root）----
const C = {
  bg: '#f8fafc', // --ja-color-neutral-50（--ja-color-bg）
  surface: '#ffffff', // --ja-color-neutral-0（--ja-color-surface）
  fg: '#0f172a', // --ja-color-neutral-900（--ja-color-fg）
  fgMuted: '#94a3b8', // --ja-color-neutral-400（最接近 --ja-color-fg-muted 的中性档）
  accent: '#16a34a', // --ja-color-green-600（--ja-color-accent）
  border: '#e2e8f0', // --ja-color-neutral-200（--ja-color-border）
};
const FONT = "Inter, 'PingFang SC', 'Helvetica Neue', Arial, sans-serif";

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <rect width="1200" height="630" fill="${C.bg}"/>
  <rect width="1200" height="10" fill="${C.accent}"/>
  <!-- 主体卡面 -->
  <rect x="72" y="110" width="1056" height="410" rx="16" fill="${C.surface}" stroke="${C.border}"/>
  <!-- 认证勾徽标 -->
  <circle cx="176" cy="230" r="52" fill="${C.accent}"/>
  <path d="M152 230 L170 248 L202 210" fill="none" stroke="#ffffff" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"/>
  <text x="260" y="222" font-family="${FONT}" font-size="64" font-weight="700" fill="${C.fg}">JobAgent</text>
  <text x="260" y="272" font-family="${FONT}" font-size="30" font-weight="500" fill="${C.accent}">Verifiable developer profiles</text>
  <text x="176" y="368" font-family="${FONT}" font-size="28" fill="${C.fg}">Every conclusion is backed by real GitHub / Gitee activity</text>
  <text x="176" y="410" font-family="${FONT}" font-size="28" fill="${C.fg}">and is traceable to its evidence — not self-reported claims.</text>
  <!-- 伪技能标签 -->
  <rect x="176" y="446" width="150" height="44" rx="10" fill="${C.bg}" stroke="${C.border}"/>
  <text x="251" y="475" text-anchor="middle" font-family="${FONT}" font-size="22" font-weight="500" fill="${C.fg}">Skill</text>
  <rect x="342" y="446" width="150" height="44" rx="10" fill="${C.bg}" stroke="${C.border}"/>
  <text x="417" y="475" text-anchor="middle" font-family="${FONT}" font-size="22" font-weight="500" fill="${C.fg}">Evidence</text>
  <rect x="508" y="446" width="150" height="44" rx="10" fill="${C.bg}" stroke="${C.border}"/>
  <text x="583" y="475" text-anchor="middle" font-family="${FONT}" font-size="22" font-weight="500" fill="${C.fg}">Proof</text>
  <!-- 页脚 -->
  <text x="72" y="576" font-family="${FONT}" font-size="24" fill="${C.fgMuted}">app.job-agent.bayjf.com</text>
  <text x="1128" y="576" text-anchor="end" font-family="${FONT}" font-size="24" fill="${C.fgMuted}">Every conclusion is verifiable</text>
</svg>`;

const html = `<!doctype html><html><body style="margin:0">${svg}</body></html>`;

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 2 });
  await page.setContent(html);
  await page.locator('svg').screenshot({ path: outPath, type: 'png' });
  console.log(`og-card written: ${outPath}`);
} finally {
  await browser.close();
}
