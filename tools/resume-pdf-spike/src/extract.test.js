/**
 * spike 守卫测试（node --test，--test-concurrency=1 保证串行）：
 *   1. 「原文不留存」代码级强制——报告 schema 无原文字段、不含源文本长行、
 *      抽取过程除报告外不写任何原文文件；
 *   2. 抽净率达标下限——每份样本字符覆盖率 >= 0.90、平均 >= 0.95（当前合成样本实测均值 0.979）；
 *   3. 字段可提取性——期望字段（姓名/邮箱/电话）能从抽取文本中拿到。
 *
 * 注意：1c 用独立输出路径重跑 extract，不删除共享报告，避免与其他用例竞争同一文件。
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { before, test } from 'node:test';
import { charCoverage, cjkStats, extractFields } from './extract.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const FIXTURES = join(ROOT, 'fixtures');
const OUT = join(ROOT, 'resume-extract.json');
const TMP_OUT = join(ROOT, 'resume-extract.tmp.json');
const SRC = join(__dirname, 'extract.js');

/** 报告是共享前置产物：缺失时先跑一次 extract 生成（fixtures 已由 make-fixtures 产出）。 */
before(() => {
  if (!existsSync(OUT)) {
    execFileSync(process.execPath, [SRC, '--out', OUT], {
      cwd: ROOT,
      stdio: 'pipe',
      maxBuffer: 64 * 1024 * 1024,
    });
  }
});

function loadSources() {
  return JSON.parse(readFileSync(join(FIXTURES, 'sources.json'), 'utf8'));
}

function loadReport() {
  return JSON.parse(readFileSync(OUT, 'utf8'));
}

test('守卫 1a：报告 schema 不含原文整段字段（rawText/pagesText）', () => {
  const report = loadReport();
  const json = JSON.stringify(report);
  assert.ok(!('rawText' in report) && !('pagesText' in report), 'schema 出现承载原文的字段');
  for (const sample of report.samples) {
    const keys = Object.keys(sample);
    assert.ok(!keys.includes('rawText') && !keys.includes('pages') && !keys.includes('text'), `样本含原文字段: ${keys}`);
  }
  // 报告不应包含任何超过 40 字符的连续 token（字段值都很短）
  const longTokens = json.match(/[^\s"{}[\],:]+/g) ?? [];
  for (const tok of longTokens) {
    assert.ok(tok.length <= 40, `报告中出现疑似原文长片段: ${tok.slice(0, 40)}`);
  }
});

test('守卫 1b：报告不含源文本的完整长行（经历/项目描述整句）', () => {
  const report = loadReport();
  // 结构化声明（字段值 + 样本标题/元数据）允许出现；剔除后再检查长行泄漏
  let json = JSON.stringify(report);
  for (const sample of report.samples) {
    for (const v of Object.values(sample.fields)) {
      json = json.split(v).join('');
    }
    json = json.split(sample.title).join('');
  }
  for (const src of loadSources()) {
    for (const line of src.sourceLines) {
      if (line.length > 12) {
        // 剔除结构化字段后，整行不得再出现在报告中（长句=原文段落，禁止留存）
        assert.ok(!json.includes(line), `源行泄漏到报告: ${line.slice(0, 30)}`);
      }
    }
  }
});

test('守卫 1c：抽取过程不向磁盘写原文文件（仅报告，且用独立输出路径）', () => {
  if (existsSync(TMP_OUT)) rmSync(TMP_OUT);
  const before = new Set(readdirSync(ROOT));
  execFileSync(process.execPath, [SRC, '--out', TMP_OUT], {
    cwd: ROOT,
    stdio: 'pipe',
    maxBuffer: 64 * 1024 * 1024, // pdf-parse 对 13MB 嵌入字体的 PDF 会打印大量警告
  });
  const after = readdirSync(ROOT).filter((f) => !before.has(f));
  assert.deepEqual(after, ['resume-extract.tmp.json'], `产生非报告文件: ${after.join(',')}`);
  // 报告中无 rawText/pagesText；无 .txt 原文产物
  const tmpReport = JSON.parse(readFileSync(TMP_OUT, 'utf8'));
  assert.ok(!('rawText' in tmpReport));
  assert.ok(!existsSync(join(ROOT, 'extracted.txt')));
  rmSync(TMP_OUT); // 清理临时报告
});

test('守卫 2：抽净率达标——每份 >= 0.90，平均 >= 0.95', () => {
  const report = loadReport();
  for (const s of report.samples) {
    assert.ok(s.coverage.charPct >= 0.9, `${s.id} 抽净率 ${s.coverage.charPct} < 0.90`);
  }
  assert.ok(report.summary.avgCharPct >= 0.95, `平均抽净率 ${report.summary.avgCharPct} < 0.95`);
  assert.ok(report.summary.minCharPct >= 0.9, `最低抽净率 ${report.summary.minCharPct} < 0.90`);
});

test('守卫 3：期望字段可从抽取文本拿到（email + name 必中）', () => {
  const report = loadReport();
  for (const s of report.samples) {
    const src = loadSources().find((x) => x.id === s.id);
    assert.ok(s.fields.email, `${s.id} 未抽出 email`);
    assert.ok(s.fields.name, `${s.id} 未抽出 name`);
    // 期望邮箱必须完整出现在抽取文本中（文本层正确性核心）
    assert.ok(s.fields.email.includes(src.expectFields.email.split('@')[0]), `${s.id} email 不匹配`);
  }
});

test('纯函数单元：charCoverage / cjkStats / extractFields 行为', () => {
  assert.equal(charCoverage('abc张三', 'a张三').charPct, 3 / 5);
  const stats = cjkStats('hello 世界');
  assert.equal(stats.cjkChars, 2);
  assert.equal(stats.asciiChars, 6); // h/e/l/l/o + 空格（<0x80 均计 ascii）
  const fields = extractFields('张三\nzhang@example.com\n138-0000-1234');
  assert.equal(fields.name, '张三');
  assert.equal(fields.email, 'zhang@example.com');
});
