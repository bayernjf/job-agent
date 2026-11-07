/**
 * Lever ATS 适配器。
 * 表单特征：#job-application-form 或 .application-form；字段 name 为 name/email/phone/github/urls 等。
 * 自定义问题字段名形如 questions[<uuid>]（id 为 question_<uuid>），问题文本在其 <label> 中；
 * summary 命中"动机/自我介绍"类问题才写入。
 */
import type { ExportableProfile } from '@jobagent/shared';
import type { AtsAdapter, FillValue, LocalFields } from './index.js';
import { findFields, findLabeledQuestion, norm, SUMMARY_HINTS, toFillValues, valueFor } from './index.js';

/**
 * 定位 Lever 新版自定义问题卡片（2026 起 `questions[<uuid>]` 改名 `cards[<uuid>][fieldN]`）。
 * 问题文本不再用 `<label>`，而是可见渲染在 `.application-question` 容器内的
 * `.application-label .text`（textarea 无 id/for 关联）；命中 SUMMARY_HINTS 才返回。
 * 只匹配 `textarea[name^="cards["]`，天然排除 baseTemplate（那是 hidden input，非 textarea）。
 */
function findLeverSummaryCard(doc: Document): HTMLTextAreaElement | null {
  for (const el of Array.from(doc.querySelectorAll('textarea[name^="cards["]'))) {
    const container = el.closest('.application-question');
    const label =
      container?.querySelector('.application-label .text') ??
      container?.querySelector('.application-label');
    const text = label?.textContent ?? '';
    // Lever 的次级说明框（"If you have additional details around your answer, please
    // share below."）是对上一个确认/是非题的补充，不是动机/自我介绍；它的 "additional"
    // 会命中 SUMMARY_HINTS 造成误写（2026-10 sonarsource 真实样本 field1），先排除。
    if (/around your answer/i.test(text)) continue;
    if (SUMMARY_HINTS.some((hint) => norm(text).includes(hint))) {
      return el as HTMLTextAreaElement;
    }
  }
  return null;
}

export const leverAdapter: AtsAdapter = {
  id: 'lever',
  name: 'Lever',

  detect(doc: Document): boolean {
    return (
      !!doc.querySelector('#job-application-form, form.application-form, [data-qa="application-form"]') ||
      /lever/i.test(doc.documentElement.outerHTML.slice(0, 100_000))
    );
  },

  mapFields(profile: ExportableProfile, local: LocalFields): FillValue[] {
    return toFillValues(profile, local);
  },

  fill(doc: Document, values: FillValue[]): number {
    let written = 0;
    const set = (keywords: string[], value: string | undefined, exclude: string[] = []): void => {
      if (!value) return;
      const el = findFields(doc, keywords, exclude)[0];
      if (el) {
        el.value = value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        written += 1;
      }
    };
    set(['name'], valueFor(values, 'full_name'));
    set(['email'], valueFor(values, 'email'));
    set(['phone'], valueFor(values, 'phone'));
    set(['location'], valueFor(values, 'location'), ['country', 'dial', 'area']);
    set(['linkedin'], valueFor(values, 'linkedin_url'));
    set(['github'], valueFor(values, 'github_url'), ['linkedin', 'website', 'portfolio']);
    // Lever 常见 "Portfolio / personal website / blog" URL 槽；排除已被 LinkedIn/GitHub 占用的字段
    set(
      ['website', 'portfolio', 'blog', 'personal site'],
      valueFor(values, 'personal_website_url'),
      ['linkedin', 'github'],
    );
    // 求职信（阶段 2 A2，cover_letter 语义键优先；缺省回退画像 summary）：
    // 只写 cover_letter 命名字段与动机/自我介绍类自定义问题；how_did_you_hear 是引流短答案，
    // 不写求职信（与 SUMMARY_HINTS 的排除口径一致）。同一元素只写一次。
    const letter = valueFor(values, 'cover_letter') ?? valueFor(values, 'summary');
    if (letter) {
      const named = findFields(doc, ['cover_letter'])[0] ?? null;
      const question =
        findLabeledQuestion(doc, /questions\[|question_/i) ?? findLeverSummaryCard(doc);
      for (const el of new Set([named, question].filter((x): x is HTMLInputElement | HTMLTextAreaElement => !!x))) {
        el.value = letter;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        written += 1;
      }
    }
    return written;
  },
};
