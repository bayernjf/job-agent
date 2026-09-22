/**
 * Lever ATS 适配器。
 * 表单特征：#job-application-form 或 .application-form；字段 name 为 name/email/phone/github/urls 等。
 * 自定义问题字段名形如 questions[<uuid>]（id 为 question_<uuid>），问题文本在其 <label> 中；
 * summary 命中"动机/自我介绍"类问题才写入。
 */
import type { ExportableProfile } from '@jobagent/shared';
import type { AtsAdapter, FillValue, LocalFields } from './index.js';
import { findFields, findLabeledQuestion, toFillValues, valueFor } from './index.js';

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
    // summary：先试 how_did_you_hear/cover_letter 关键词字段，未命中则写入动机/自我介绍类自定义问题
    const summary = valueFor(values, 'summary');
    if (summary) {
      const el = findFields(doc, ['how_did_you_hear', 'cover_letter'])[0] ?? findLabeledQuestion(doc, /questions\[|question_/i);
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
