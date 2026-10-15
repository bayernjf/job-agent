#!/usr/bin/env node
/**
 * 抓取真实 ATS 申请页 DOM 样本 → tests/fixtures/ats/（回归夹具，配合
 * apps/extension/src/ats/real-dom-regression.test.ts 使用）。
 *
 * 用途：ATS 改版导致扩展适配器静默失效时，重抓样本即可让回归测试变红。
 * 用法：node tools/capture-ats-samples.mjs [--only greenhouse,lever,ashby]
 *
 * 样本口径：
 * - 全部为**公开申请页**，无个人信息，无需脱敏；EEO/营销同意字段原样保留（适配器本就不得触碰）。
 * - Greenhouse：board 索引页提取首个在招职位 id，抓 `embed/job_app`（SSR 完整表单，
 *   即公司官网 iframe 嵌入的同一份标记）；新域名 job-boards.greenhouse.io 职位页是纯 SPA 壳，抓不到表单。
 * - Lever：`/apply` 页 SSR 直接带完整表单，两家租户（sonarsource/alluxio）以覆盖字段命名差异。
 * - Ashby：整站 React SPA，静态 HTML 无表单，需 Playwright 渲染职位页并点击 Apply 展开表单后存 DOM；
 *   浏览器不可用时跳过（manifest 只登记成功的样本，回归测试按 manifest 迭代，不会因此变红）。
 * - Workday 不抓：myworkdayjobs.com 投递是多步账号门槛流程（需登录建账号），
 *   其 data-automation-id 逻辑继续由 ats.test.ts 的 fake-doc 单测覆盖。
 *
 * 夹具更新即重跑本脚本并提交结果；回归断言采用「最少写入字段数 + 关键字段落值 + 防误写」，
 * 对常规换岗重抓稳健，对 ATS 真实改版（字段重命名/结构调整）敏感。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../tests/fixtures/ats');
const UA = {
  'user-agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
};

const GREENHOUSE_BOARD = 'anthropic';
const LEVER_BOARDS = ['sonarsource', 'alluxio'];
const ASHBY_BOARD = 'linear';

/** @param {string} url */
async function fetchText(url) {
  const res = await fetch(url, { headers: UA, redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return { finalUrl: res.url, html: await res.text() };
}

async function captureGreenhouse() {
  const index = await fetchText(`https://job-boards.greenhouse.io/${GREENHOUSE_BOARD}`);
  const jobId = index.html.match(/\/jobs\/(\d+)/)?.[1];
  if (!jobId) throw new Error('board 索引页未提取到职位 id');
  const sourceUrl = `https://boards.greenhouse.io/embed/job_app?for=${GREENHOUSE_BOARD}&token=${jobId}`;
  const page = await fetchText(sourceUrl);
  if (!/id="application-form"/.test(page.html)) throw new Error('embed 页缺少 #application-form，Greenhouse 可能又改版');
  return {
    file: `greenhouse-${GREENHOUSE_BOARD}.html`,
    ats: 'greenhouse',
    mode: 'ssr-embed',
    sourceUrl,
    finalUrl: page.finalUrl,
    html: page.html,
  };
}

/** @param {string} slug */
async function captureLever(slug) {
  const index = await fetchText(`https://jobs.lever.co/${slug}`);
  const posting = index.html.match(new RegExp(`href="(https://jobs\\.lever\\.co/${slug}/[a-f0-9-]+)"`))?.[1];
  if (!posting) throw new Error('board 索引页未提取到职位链接');
  const sourceUrl = `${posting}/apply`;
  const page = await fetchText(sourceUrl);
  if (!/<form[^>]*id="application-form"/.test(page.html)) {
    throw new Error('apply 页缺少 form#application-form，Lever 可能又改版');
  }
  return {
    file: `lever-${slug}.html`,
    ats: 'lever',
    mode: 'ssr-apply',
    sourceUrl,
    finalUrl: page.finalUrl,
    html: page.html,
  };
}

async function captureAshby() {
  const index = await fetchText(`https://jobs.ashbyhq.com/${ASHBY_BOARD}`);
  const postingId = index.html.match(/"jobPostings":\[{"id":"([0-9a-f-]{36})"/)?.[1];
  if (!postingId) throw new Error('board 索引页未提取到职位 id');
  const sourceUrl = `https://jobs.ashbyhq.com/${ASHBY_BOARD}/${postingId}`;

  // SPA：必须用真实浏览器渲染并展开申请表单
  const { chromium } = await import('@playwright/test');
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(sourceUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    // 部分职位页表单直接展示；否则点击 Apply 展开
    const hasForm = await page
      .waitForSelector('[id*="_systemfield_"]', { timeout: 5_000 })
      .then(() => true)
      .catch(() => false);
    if (!hasForm) {
      await page.getByRole('button', { name: /apply/i }).first().click({ timeout: 10_000 });
      await page.waitForSelector('[id*="_systemfield_"]', { timeout: 15_000 });
    }
    const html = await page.content();
    if (!/_systemfield_/.test(html)) throw new Error('渲染后仍无 _systemfield_ 字段，Ashby 可能又改版');
    return {
      file: `ashby-${ASHBY_BOARD}.html`,
      ats: 'ashby',
      mode: 'rendered-spa',
      sourceUrl,
      finalUrl: page.url(),
      html,
    };
  } finally {
    await browser.close();
  }
}

async function main() {
  const only = process.argv.includes('--only')
    ? process.argv[process.argv.indexOf('--only') + 1].split(',')
    : null;
  const want = (name) => !only || only.includes(name);

  mkdirSync(OUT_DIR, { recursive: true });
  const samples = [];
  const tasks = [];
  if (want('greenhouse')) tasks.push(['greenhouse', () => captureGreenhouse()]);
  if (want('lever')) for (const slug of LEVER_BOARDS) tasks.push([`lever:${slug}`, () => captureLever(slug)]);
  if (want('ashby')) tasks.push(['ashby', () => captureAshby()]);

  for (const [name, run] of tasks) {
    try {
      const sample = await run();
      writeFileSync(path.join(OUT_DIR, sample.file), sample.html);
      const { html: _omit, ...meta } = sample;
      samples.push({ ...meta, capturedAt: new Date().toISOString() });
      console.log(`ok   ${name} -> ${sample.file} (${sample.html.length} bytes)`);
    } catch (err) {
      console.warn(`SKIP ${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (samples.length === 0) {
    console.error('没有抓到任何样本，manifest 未更新');
    process.exit(1);
  }
  const manifest = {
    note: '真实公开 ATS 申请页 DOM 样本（tools/capture-ats-samples.mjs 录制）。无个人信息无需脱敏；回归测试见 apps/extension/src/ats/real-dom-regression.test.ts。Workday 因多步账号门槛流程不抓，继续由 fake-doc 单测覆盖。',
    samples,
  };
  writeFileSync(path.join(OUT_DIR, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`manifest.json 更新（${samples.length} 个样本）`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
