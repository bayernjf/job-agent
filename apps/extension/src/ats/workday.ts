/**
 * Workday ATS 适配器（骨架）。
 * 特征：*.myworkdayjobs.com 域名 + 深组件结构（shadow DOM / aria），字段定位成本高，
 * 当前只识别页面并填充最外层可见的标准字段（input[name] 匹配），
 * 完整 shadow DOM 表单定位列入后续迭代（见 handoff/deferred）。
 */
import type { ExportableProfile } from '@jobagent/shared';
import type { AtsAdapter, FillValue, LocalFields } from './index.js';
import { findFields, toFillValues, valueFor } from './index.js';

export const workdayAdapter: AtsAdapter = {
  id: 'workday',
  name: 'Workday',

  detect(doc: Document): boolean {
    const hostname = typeof location === 'undefined' ? '' : location.hostname;
    return (
      /myworkdayjobs\.com|workday/i.test(hostname + doc.documentElement.outerHTML.slice(0, 50_000))
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
    // 拆 first/last，避免宽松 'name' 误匹配 Company/Preferred name 等
    const nameParts = (valueFor(values, 'full_name') ?? '').trim().split(/\s+/);
    set(['first_name'], nameParts[0]);
    set(['last_name'], nameParts.slice(1).join(' '));
    set(['email'], valueFor(values, 'email'));
    set(['phone'], valueFor(values, 'phone'));
    set(['location'], valueFor(values, 'location'));
    // Workday 的 GitHub/LinkedIn 链接字段在深层组件内，待后续迭代
    void valueFor(values, 'github_url');
    void valueFor(values, 'linkedin_url');
    return written;
  },
};
