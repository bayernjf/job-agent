/**
 * 真实 ATS DOM 回归测试：让四个适配器的 detect/fill 跑在 tests/fixtures/ats/ 下
 * 录制的公开申请页样本上（tools/capture-ats-samples.mjs 抓取，manifest.json 登记）。
 *
 * 目的：ATS 改版导致适配器静默失效时让套件变红。用法——怀疑改版或岗位失效时
 * 重抓样本（node tools/capture-ats-samples.mjs），本测试随即按新样本重放；
 * 重抓是刻意行为，若断言随新样本漂移，应同步审阅本文件（断言与具体样本钉合，
 * 不做"任何岗位都通用"的弱断言，否则等于没钉）。
 *
 * 断言口径：detectAts 命中正确适配器 + minWritten（不用精确写入数，换岗不致误红）
 * + 关键字段落值 + 防误写（国家/引流/本地语言名等近邻字段必须保持空）。
 *
 * 运行环境：node + 手动 JSDOM（样本 url 取自 manifest.finalUrl，为 ashby/workday
 * detect 的 location.hostname 判据提供真实主机名；Event 全局也由 jsdom window 提供）。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { JSDOM, VirtualConsole } from 'jsdom';
import type { ExportableProfile } from '@jobagent/shared';
import { detectAts, listAdapters, type LocalFields } from './index.js';

const FIXTURES = path.resolve(
  path.dirname(expect.getState().testPath!),
  '../../../../tests/fixtures/ats',
);

interface SampleMeta {
  file: string;
  ats: 'greenhouse' | 'lever' | 'workday' | 'ashby';
  mode: string;
  sourceUrl: string;
  finalUrl: string;
  capturedAt: string;
}

const manifest = JSON.parse(readFileSync(path.join(FIXTURES, 'manifest.json'), 'utf8')) as {
  samples: SampleMeta[];
};

function sample(file: string): SampleMeta {
  const meta = manifest.samples.find((s) => s.file === file);
  if (!meta) throw new Error(`样本未登记在 manifest.json: ${file}（重抓后请同步本测试）`);
  return meta;
}

/** 防误写断言辅助：字段当前值必须为空 */
function expectEmpty(el: Element | null, what: string): void {
  expect(el, `${what} 应存在`).not.toBeNull();
  expect((el as HTMLInputElement).value, `${what} 必须保持空（防误写）`).toBe('');
}

/** 按 label[for] 文本定位字段（Ashby 自定义问题 id 是裸 UUID，只能走 label） */
function fieldByLabel(doc: Document, labelText: string): HTMLInputElement | HTMLTextAreaElement | null {
  for (const label of Array.from(doc.querySelectorAll('label'))) {
    if ((label.textContent ?? '').trim().startsWith(labelText)) {
      const id = label.getAttribute('for');
      if (id) return doc.getElementById(id) as HTMLInputElement | HTMLTextAreaElement | null;
    }
  }
  return null;
}

function profile(): ExportableProfile {
  return {
    schemaVersion: '0.1',
    profileId: 'prof-regression',
    generatedAt: '2026-10-15T00:00:00.000Z',
    analyzerVersion: '0.9.0',
    subject: {
      platform: 'github',
      login: 'ada',
      displayName: 'Ada Lovelace',
      profileUrl: 'https://github.com/ada',
      claimed: false,
    },
    headline: 'Backend engineer',
    skills: [
      { name: 'TypeScript', kind: 'language', depth: 'proficient', confidence: 0.9, evidenceRefs: [] },
    ],
    authenticity: { status: 'likely_authentic', confidence: 0.9 },
  };
}

const LOCAL: LocalFields = {
  email: 'ada@example.com',
  phone: '+86 138 0000 0000',
  location: 'Hangzhou',
  linkedinUrl: 'https://linkedin.com/in/ada',
  personalWebsite: 'https://ada.dev',
};

/** jsdom 对样本内 <style> 的 CSS 解析报错是噪音（不影响 DOM），只压掉这两类 */
const virtualConsole = new VirtualConsole();
virtualConsole.on('jsdomError', (e) => {
  if (/Could not parse CSS|Could not load/.test(e.message)) return;
  console.error(e);
});

function loadSample(meta: SampleMeta): Document {
  const html = readFileSync(path.join(FIXTURES, meta.file), 'utf8');
  const dom = new JSDOM(html, { url: meta.finalUrl, virtualConsole });
  // 适配器运行期依赖两个页面全局：Event（fill 派发 input/change）与
  // location.hostname（ashby/workday detect）。用样本自己的 window 提供，afterEach 恢复。
  (globalThis as Record<string, unknown>).Event = dom.window.Event;
  Object.defineProperty(globalThis, 'location', {
    value: dom.window.location,
    configurable: true,
  });
  return dom.window.document as unknown as Document;
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'location');
  Reflect.deleteProperty(globalThis, 'Event');
});

function fillWith(doc: Document, ats: SampleMeta['ats']): number {
  const adapter = listAdapters().find((a) => a.id === ats);
  expect(adapter, `适配器 ${ats} 未注册`).toBeDefined();
  return adapter!.fill(doc, adapter!.mapFields(profile(), LOCAL));
}

describe('真实 ATS DOM 回归（tests/fixtures/ats）', () => {
  it('manifest 至少登记 3 份样本且文件存在（反空转）', () => {
    expect(manifest.samples.length).toBeGreaterThanOrEqual(3);
    for (const s of manifest.samples) {
      expect(() => readFileSync(path.join(FIXTURES, s.file), 'utf8')).not.toThrow();
    }
  });

  it('greenhouse-anthropic：embed 新表单（application-form 连字符版）', () => {
    const meta = sample('greenhouse-anthropic.html');
    const doc = loadSample(meta);
    expect(detectAts(doc)?.id).toBe('greenhouse');

    const written = fillWith(doc, 'greenhouse');
    expect(written).toBeGreaterThanOrEqual(4);

    expect((doc.getElementById('first_name') as HTMLInputElement).value).toBe('Ada');
    expect((doc.getElementById('last_name') as HTMLInputElement).value).toBe('Lovelace');
    expect((doc.getElementById('email') as HTMLInputElement).value).toBe(LOCAL.email);
    expect((doc.getElementById('phone') as HTMLInputElement).value).toBe(LOCAL.phone);

    // 防误写：react-select 国家 combobox 不能被电话/城市串写入（真机事故回归位）
    expectEmpty(doc.getElementById('country'), '#country 国家框');
    // 防误写：本样本唯一自定义问题是签证下拉（label 无 SUMMARY_HINTS），不得写 summary
    // 只查表单字段本体——react-select 会派生 <id>-label 等辅助元素（无 .value）
    const questionFields = Array.from(
      doc.querySelectorAll('input[id^="question_"], textarea[id^="question_"], select[id^="question_"]'),
    );
    expect(questionFields.length, '样本应至少有一个 question_ 字段（反空转）').toBeGreaterThan(0);
    for (const el of questionFields) {
      expectEmpty(el, `#${el.id} 自定义问题`);
    }
  });

  it('lever-sonarsource：SSR /apply 表单（无 GitHub/Portfolio 槽）', () => {
    const meta = sample('lever-sonarsource.html');
    const doc = loadSample(meta);
    expect(detectAts(doc)?.id).toBe('lever');

    const written = fillWith(doc, 'lever');
    expect(written).toBeGreaterThanOrEqual(5);

    const val = (name: string): string =>
      (doc.querySelector(`input[name="${name}"]`) as HTMLInputElement)?.value ?? '';
    expect(val('name')).toBe('Ada Lovelace');
    expect(val('email')).toBe(LOCAL.email);
    expect(val('phone')).toBe(LOCAL.phone);
    expect(val('location')).toBe(LOCAL.location);
    expect(val('urls[LinkedIn]')).toBe(LOCAL.linkedinUrl);

    // 钉住 Lever 新版 cards[<uuid>][fieldN] 结构：定位已支持（findLeverSummaryCard，见 lever.ts），
    // 但 sonarsource 样本的三道 card（office/sponsorship/notice period）均非动机类、
    // 不命中 SUMMARY_HINTS，故仍须保持空；动机类 card 的写入由 ats.test.ts 的合成 JSDOM
    // 用例覆盖（真实样本无法覆盖该分支）。
    const cards = Array.from(doc.querySelectorAll('textarea[name^="cards["]'));
    expect(cards.length).toBeGreaterThan(0);
    for (const el of cards) expectEmpty(el, `textarea ${el.getAttribute('name')}`);
  });

  it('lever-alluxio：带 GitHub/Portfolio URL 槽的另一租户', () => {
    const meta = sample('lever-alluxio.html');
    const doc = loadSample(meta);
    expect(detectAts(doc)?.id).toBe('lever');

    const written = fillWith(doc, 'lever');
    expect(written).toBeGreaterThanOrEqual(7);

    const val = (name: string): string =>
      (doc.querySelector(`input[name="${name}"]`) as HTMLInputElement)?.value ?? '';
    expect(val('name')).toBe('Ada Lovelace');
    expect(val('email')).toBe(LOCAL.email);
    expect(val('phone')).toBe(LOCAL.phone);
    expect(val('location')).toBe(LOCAL.location);
    expect(val('urls[LinkedIn]')).toBe(LOCAL.linkedinUrl);
    expect(val('urls[Github]')).toBe('https://github.com/ada');
    expect(val('urls[Portfolio]')).toBe(LOCAL.personalWebsite);
  });

  it('ashby-linear：SPA 渲染样本，detect 顺序须压过 lever/workday 误判', () => {
    const meta = sample('ashby-linear.html');
    const doc = loadSample(meta);
    // 回归核心：该页面同时命中 lever（#job-application-form 同名）与
    // workday（正文含 "workday" 字样）的 detect 特征，detectAts 必须仍返回 ashby
    expect(detectAts(doc)?.id).toBe('ashby');

    const written = fillWith(doc, 'ashby');
    expect(written).toBeGreaterThanOrEqual(4);

    expect((doc.getElementById('_systemfield_name') as HTMLInputElement).value).toBe(
      'Ada Lovelace',
    );
    expect((doc.getElementById('_systemfield_email') as HTMLInputElement).value).toBe(
      LOCAL.email,
    );
    // LinkedIn 是自定义问题（UUID id），按 label 文本定位写入
    expect(fieldByLabel(doc, 'LinkedIn profile')?.value).toBe(LOCAL.linkedinUrl);
    // "Why Linear?" 命中 SUMMARY_HINTS，summary 应写入
    expect(fieldByLabel(doc, 'Why Linear?')?.value).toContain('Backend engineer');

    // 防误写：X handle / 国家 / 推荐人姓名不得被 URL 串或 summary 污染
    expectEmpty(fieldByLabel(doc, 'X handle'), 'X handle 字段');
    expectEmpty(fieldByLabel(doc, 'What country are you based in?'), '国家问题字段');
    expectEmpty(fieldByLabel(doc, 'Has someone at Linear referred you'), '推荐人字段');
  });
});
