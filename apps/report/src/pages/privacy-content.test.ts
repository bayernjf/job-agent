/**
 * 隐私政策一致性守护测试（CWS 上架要求可公开访问的隐私政策）。
 *
 * 权威源是 docs/privacy-policy-20260924.md（中英双语 markdown，供人工/商店审阅），
 * 用户可见页是 apps/report/src/pages/[locale]/privacy.astro（内联 en/zhCN 两份章节数据）。
 * 两处独立维护、曾经无任何机制防止"改了一边忘另一边"。本测试：
 *   1. 从 markdown 按语言段提取 `#### N. 标题` 章节标题；
 *   2. 从 privacy.astro 源码提取内联数据里的全部 `heading: '...'`（前 10 en、后 10 zh-CN）；
 *   3. 断言章节数（各 10）、序号（1..10）与标题逐字一致；
 *   4. 断言两侧"最后更新"日期一致。
 *
 * 刻意以纯文本解析（fs + 正则）而非 import .astro：内容数据是 content-as-data，
 * 这里只守护"权威源 ↔ 在线页"同步，不依赖 Astro 编译器。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = fileURLToPath(new URL('.', import.meta.url));
// 本文件位于 apps/report/src/pages/；仓库根需上溯 4 级（pages→src→report→apps→根）
const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const astroSource = readFileSync(`${here}[locale]/privacy.astro`, 'utf8');
const markdown = readFileSync(`${repoRoot}docs/privacy-policy-20260924.md`, 'utf8');

/** 从 markdown 的某个 `## 段标题` 到（可选）下一个 `## ` 段之间，提取所有 `#### N. title`。 */
function extractMarkdownHeadings(source: string, sectionMarker: string, endMarker?: string): string[] {
  const start = source.indexOf(sectionMarker);
  if (start === -1) throw new Error(`markdown section not found: ${sectionMarker}`);
  const end = endMarker ? source.indexOf(endMarker, start) : -1;
  const segment = end === -1 ? source.slice(start) : source.slice(start, end);
  return [...segment.matchAll(/^####\s+(.+?)\s*$/gm)].map((m) => m[1]!.trim());
}

/** 从 privacy.astro 源码按出现顺序提取全部内联章节 heading。 */
function extractAstroHeadings(source: string): string[] {
  return [...source.matchAll(/heading:\s*'([^']+)'/g)].map((m) => m[1]!.trim());
}

function expectNumberedOneThroughTen(headings: string[], label: string): void {
  expect(headings.length, `${label} must have exactly 10 sections`).toBe(10);
  headings.forEach((heading, i) => {
    expect(heading, `${label} section #${i + 1}`).toMatch(new RegExp(`^${i + 1}\\.\\s`));
  });
}

describe('privacy policy source ↔ online page consistency', () => {
  const mdEn = extractMarkdownHeadings(markdown, '## English', '## 中文');
  const mdZh = extractMarkdownHeadings(markdown, '## 中文（简体）');
  const astroHeadings = extractAstroHeadings(astroSource);
  const astroEn = astroHeadings.slice(0, 10);
  const astroZh = astroHeadings.slice(10, 20);

  it('parses ten sections for each language from the canonical markdown', () => {
    expectNumberedOneThroughTen(mdEn, 'markdown English');
    expectNumberedOneThroughTen(mdZh, 'markdown Chinese');
  });

  it('privacy.astro declares exactly twenty inline headings (10 en + 10 zh-CN)', () => {
    expect(astroHeadings.length, 'expected 10 English then 10 Chinese headings').toBe(20);
    expectNumberedOneThroughTen(astroEn, 'astro English');
    expectNumberedOneThroughTen(astroZh, 'astro Chinese');
  });

  it('keeps English section headings identical between markdown and the online page', () => {
    expect(astroEn).toEqual(mdEn);
  });

  it('keeps Chinese section headings identical between markdown and the online page', () => {
    expect(astroZh).toEqual(mdZh);
  });

  it('keeps the last-updated date in sync between markdown and the online page', () => {
    const astroDate = astroSource.match(/const\s+lastUpdated\s*=\s*'([^']+)'/)?.[1];
    const mdEnDate = markdown.match(/_Last updated:\s*([^_]+)_/)?.[1]?.trim();
    const mdZhDate = markdown.match(/_最后更新：\s*([^_]+)_/)?.[1]?.trim();
    expect(astroDate, 'astro lastUpdated').toBeTruthy();
    expect(mdEnDate, 'markdown English last updated').toBeTruthy();
    expect(mdZhDate, 'markdown Chinese last updated').toBeTruthy();
    expect(mdEnDate).toBe(astroDate);
    expect(mdZhDate).toBe(astroDate);
  });
});
