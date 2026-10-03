/**
 * PDF 文本抽取 spike 的抽取侧：pdf-parse 抽取 → 字段结构化 → 抽净率对账。
 *
 * 「原文不留存」硬约束（deferred 行）在这里以代码级强制落地：
 *   - 抽取结果只输出**结构化声明**（字段值 + 统计 + 覆盖率），输出 schema 中
 *     不存在任何承载原文整段文本的字段（如 rawText / pagesText）；
 *   - 处理全程在内存完成，不向磁盘写入任何 .txt/.raw 原文文件；
 *   - 对应守卫见 src/extract.test.js（断言输出不含源文本长行、无新增原文文件）。
 *
 * 用法：node src/extract.js [--out resume-extract.json]
 * 输出：tools/resume-pdf-spike/resume-extract.json（结构化，可审计）
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pdfParse from 'pdf-parse';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const FIXTURES = join(ROOT, 'fixtures');
const DEFAULT_OUT = join(ROOT, 'resume-extract.json');

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const PHONE_RE = /(?:\+?\d[\d\s.-]{5,}\d)/;
const GITHUB_RE = /github\.com\/[A-Za-z0-9_-]+/i;

/** 从抽取文本中提取结构化工段（合成样本的简单规则；真实简历的字段解析是生产化阶段的事）。 */
export function extractFields(text) {
  const fields = {};
  const email = text.match(EMAIL_RE);
  const phone = text.match(PHONE_RE);
  const github = text.match(GITHUB_RE);
  // 姓名：取 header 首行——合成样本首行就是姓名（中英混排变体的首行可能是 "李娜 / Li Na"）
  const firstLine = text.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0 && l.length < 40);
  if (firstLine) fields.name = firstLine.split(/[｜|/]/)[0].trim();
  if (email) fields.email = email[0];
  if (phone) fields.phone = phone[0];
  if (github) fields.github = github[0];
  return fields;
}

/** 字符覆盖率：源文本字符有多少出现在抽取文本中（去空白后按字符比对）。 */
export function charCoverage(sourceText, extractedText) {
  const norm = (s) => s.replace(/\s+/g, '');
  const src = norm(sourceText);
  const ext = norm(extractedText);
  if (src.length === 0) return { charPct: 1, matchedChars: 0, sourceChars: 0 };
  let matched = 0;
  for (const ch of src) {
    if (ext.includes(ch)) matched += 1;
  }
  return { charPct: Number((matched / src.length).toFixed(4)), matchedChars: matched, sourceChars: src.length };
}

export function cjkStats(text) {
  let cjk = 0;
  let ascii = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (code >= 0x4e00 && code <= 0x9fff) cjk += 1;
    else if (code < 0x80) ascii += 1;
  }
  return { cjkChars: cjk, asciiChars: ascii, totalChars: text.replace(/\s+/g, '').length };
}

async function extractOne(pdfPath) {
  const buffer = readFileSync(pdfPath);
  const data = await pdfParse(buffer); // 内存解析，不落盘
  return data.text;
}

async function main() {
  const outPath = process.argv.includes('--out')
    ? process.argv[process.argv.indexOf('--out') + 1]
    : DEFAULT_OUT;
  const sources = JSON.parse(readFileSync(join(FIXTURES, 'sources.json'), 'utf8'));
  const samples = [];
  let fieldHits = 0;
  let fieldTotal = 0;

  for (const src of sources) {
    const text = await extractOne(join(FIXTURES, `${src.id}.pdf`));
    const fields = extractFields(text);
    const sourceText = src.sourceLines.join('\n');
    const coverage = charCoverage(sourceText, text);
    // 字段命中：expectFields 的每个值都应出现在抽取文本中（姓名/邮箱/电话）
    for (const [k, v] of Object.entries(src.expectFields)) {
      fieldTotal += 1;
      if (v && text.includes(v)) fieldHits += 1;
    }
    samples.push({
      id: src.id,
      title: src.title,
      textStats: cjkStats(text),
      fields,
      coverage,
    });
    console.log(`  ✓ ${src.id}: chars=${coverage.matchedChars}/${coverage.sourceChars} (${(coverage.charPct * 100).toFixed(1)}%) fields=${JSON.stringify(fields)}`);
  }

  const charPcts = samples.map((s) => s.coverage.charPct);
  const summary = {
    pipeline: 'pdf-parse@1.1.4',
    sampleCount: samples.length,
    avgCharPct: Number((charPcts.reduce((a, b) => a + b, 0) / charPcts.length).toFixed(4)),
    minCharPct: Number(Math.min(...charPcts).toFixed(4)),
    fieldHitRate: Number((fieldHits / fieldTotal).toFixed(4)),
  };

  const report = { generatedAt: new Date().toISOString(), summary, samples };
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`\n报告已写出：${outPath}`);
  console.log(`汇总：平均抽净率 ${(summary.avgCharPct * 100).toFixed(1)}% / 最低 ${(summary.minCharPct * 100).toFixed(1)}% / 字段命中率 ${(summary.fieldHitRate * 100).toFixed(1)}%`);
}

// CLI 直跑（node src/extract.js）时才执行 main；被测试 import 时不触发。
const isCli = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isCli) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
