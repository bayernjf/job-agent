/**
 * Ashby ATS 适配器。
 * 表单特征：jobs.ashbyhq.com 单页 React SPA，Application 面板 id=job-application-form（与 Lever 同名，
 * 靠域名区分）。系统字段 id 前缀 _systemfield_（name/email/resume 等，公司配置不同）；其余全是
 * 自定义问题——字段 id 为裸 UUID（无前缀），问题文本在其关联 <label> 中。
 *
 * 填充策略（2026-10-10 真机探测 Linear/Supabase 表单后定型）：
 * - name/email/phone 按系统字段 id 关键字匹配（Ashby 是 Name 单输入，不拆 first/last）；
 * - GitHub/LinkedIn/Portfolio 等 URL 槽在不同公司被配置为自定义问题（Linear/Supabase 均如此），
 *   须按 label 文本定位（findFieldsByLabel），系统字段存在时优先；
 * - summary/cover_letter 只写入命中动机/自我介绍类 label（SUMMARY_HINTS）的自定义问题，
 *   绝不写进引流（Where did you hear）、国家/授权类问题；
 * - location 类字段（国家/城市问题 label 多样且易错位）暂不填，宁缺毋滥（无证据不臆填）。
 */
import type { ExportableProfile } from '@jobagent/shared';
import type { AtsAdapter, FillValue, LocalFields } from './index.js';
import { findFields, findFieldsByLabel, findLabeledQuestion, toFillValues, valueFor } from './index.js';

/** Ashby 自定义问题字段 id 为裸 UUID */
const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

export const ashbyAdapter: AtsAdapter = {
  id: 'ashby',
  name: 'Ashby',

  detect(doc: Document): boolean {
    const hostname = typeof location === 'undefined' ? '' : location.hostname;
    const head = doc.documentElement.outerHTML.slice(0, 50_000);
    return /ashbyhq\.com/i.test(hostname) || (/_systemfield_/i.test(head) && /ashby/i.test(head));
  },

  mapFields(profile: ExportableProfile, local: LocalFields): FillValue[] {
    return toFillValues(profile, local);
  },

  fill(doc: Document, values: FillValue[]): number {
    let written = 0;
    const write = (el: Element | null | undefined, value: string | undefined): void => {
      if (!el || !value) return;
      (el as HTMLInputElement).value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      written += 1;
    };
    // 单字段全名（Ashby 是 Name 单输入，不是 first/last 拆分；排除 first/last/user 防误中拆分字段）
    write(findFields(doc, ['name'], ['first', 'last', 'user'])[0], valueFor(values, 'full_name'));
    write(findFields(doc, ['email'])[0], valueFor(values, 'email'));
    write(
      findFields(doc, ['phone'], ['country', 'dial', 'area', 'extension'])[0],
      valueFor(values, 'phone'),
    );
    // URL 槽：系统字段优先，回退按 label 定位自定义问题（Linear/Supabase 的 GitHub/LinkedIn 均为自定义问题）
    const urlSlot = (keywords: string[], value: string | undefined, exclude: string[]): void => {
      if (!value) return;
      write(findFields(doc, keywords, exclude)[0] ?? findFieldsByLabel(doc, keywords, exclude)[0], value);
    };
    urlSlot(['linkedin'], valueFor(values, 'linkedin_url'), ['github', 'portfolio', 'website']);
    urlSlot(['github'], valueFor(values, 'github_url'), ['linkedin', 'portfolio', 'website']);
    urlSlot(
      ['portfolio', 'website', 'blog', 'personal site'],
      valueFor(values, 'personal_website_url'),
      ['linkedin', 'github'],
    );
    // 求职信（A2，cover_letter 语义键优先；缺省回退画像 summary）：只写 cover_letter 命名字段与
    // 动机/自我介绍类自定义问题（UUID id + label 命中 SUMMARY_HINTS），同一元素只写一次。
    const letter = valueFor(values, 'cover_letter') ?? valueFor(values, 'summary');
    if (letter) {
      const named = findFields(doc, ['cover_letter'])[0] ?? null;
      const question = findLabeledQuestion(doc, UUID_PATTERN);
      for (const el of new Set(
        [named, question].filter((x): x is HTMLInputElement | HTMLTextAreaElement => !!x),
      )) {
        write(el, letter);
      }
    }
    return written;
  },
};
