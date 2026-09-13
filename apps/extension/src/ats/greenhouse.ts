/**
 * Greenhouse ATS 适配器。
 * 表单特征：#application_form（Greenhouse 内嵌或 iframe 内），字段 name 前缀 job_application[...]。
 * 自定义问题字段名形如 question_<id> / job_application[answers][<id>]，问题文本在其 <label> 中；
 * summary 只写入命中"动机/自我介绍"类问题的自由文本字段（cover_letter 是 file input，无法填文本）。
 */
import type { ExportableProfile } from '@jobagent/shared';
import type { AtsAdapter, FillValue, LocalFields } from './index.js';
import { findFields, findLabeledQuestion, toFillValues, valueFor } from './index.js';

export const greenhouseAdapter: AtsAdapter = {
  id: 'greenhouse',
  name: 'Greenhouse',

  detect(doc: Document): boolean {
    return (
      !!doc.querySelector('#application_form, form[data-ember-action]') ||
      /greenhouse|grnhs/i.test(doc.documentElement.outerHTML.slice(0, 200_000))
    );
  },

  mapFields(profile: ExportableProfile, local: LocalFields): FillValue[] {
    return toFillValues(profile, local);
  },

  fill(doc: Document, values: FillValue[]): number {
    let written = 0;
    const set = (keywords: string[], value: string | undefined): void => {
      if (!value) return;
      const el = findFields(doc, keywords)[0];
      if (el) {
        el.value = value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        written += 1;
      }
    };
    // full_name 拆分为 first/last（greenhouse 新版表单字段只有 id：first_name/last_name）
    const nameParts = (valueFor(values, 'full_name') ?? '').trim().split(/\s+/);
    set(['first_name'], nameParts[0]);
    set(['last_name'], nameParts.slice(1).join(' '));
    set(['email'], valueFor(values, 'email'));
    set(['phone'], valueFor(values, 'phone'));
    set(['country', 'location'], valueFor(values, 'location'));
    set(['linkedin'], valueFor(values, 'linkedin_url'));
    set(['github'], valueFor(values, 'github_url'));
    // summary：先试 cover_letter/summary 关键词字段，未命中则写入动机/自我介绍类自定义问题
    const summary = valueFor(values, 'summary');
    if (summary) {
      const el = findFields(doc, ['cover_letter', 'summary'])[0] ?? findLabeledQuestion(doc, /question_|answers\[/i);
      if (el) {
        el.value = summary;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        written += 1;
      }
    }
    return written;
  },
};
