/**
 * Workday ATS 适配器。
 * 特征：*.myworkdayjobs.com 域名 + 全组件化表单（shadow DOM / aria）。
 * 字段定位键 = data-automation-id（真实探测 2026-10-10，Intel/GDIT 两个租户确认）：
 *   - legal-name-section_firstName / lastName        → 英文名/姓（Western Script）
 *   - legal-name-section_firstNameLocal / lastNameLocal → 本地（中文）名/姓，刻意不填
 *   - email / phoneNumber                             → 邮箱 / 电话
 *   - file-upload-input-ref                           → 简历上传（file input，用户手动，不自动触发）
 *   - consentCheckbox                                 → 同意条款（checkbox，用户主动勾选，不自动勾选）
 * 边界（决策 #15/#20）：只填文本字段并停手；不自动提交、不自动上传、不勾选同意条款。
 * 语义防误写：firstNameLocal/lastNameLocal 是本地语言名（如中文名），用 exclude 排除；
 * phoneCountryCode/phoneDeviceType 等近邻字段用 exclude 排除，避免写错框。
 */
import type { ExportableProfile } from '@jobagent/shared';
import type { AtsAdapter, FillValue, LocalFields } from './index.js';
import { findFields, toFillValues, valueFor } from './index.js';

const WD_EMAIL = ['email'];
const WD_PHONE = ['phone'];
// norm() 不拆 camelCase：data-automation-id="legal-name-section_firstName" 归一化为
// "legal name section firstname"（first+name 连写），故关键词需同时带无空格变体
const WD_NAME = ['firstname', 'givenname', 'first name', 'given name'];
const WD_FAMILY = ['lastname', 'familyname', 'last name', 'family name'];
/** 本地语言名（中文名/日文名等）与区号/类型近邻字段，排除以免误写 */
const EXCLUDE_LOCAL_NAME = ['local'];
const EXCLUDE_PHONE_NEIGHBOR = ['country', 'type', 'extension'];

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
    const set = (keywords: string[], exclude: string[], value: string | undefined): void => {
      if (!value) return;
      const el = findFields(doc, keywords, exclude)[0];
      if (el) {
        el.value = value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        written += 1;
      }
    };
    // 姓名优先拆 first/last（Workday 英文名槽 = Western Script）；full_name 缺失时兜底不写。
    const nameParts = (valueFor(values, 'full_name') ?? '').trim().split(/\s+/);
    const given = nameParts[0];
    const family = nameParts.slice(1).join(' ');
    if (given && family) {
      set(WD_NAME, EXCLUDE_LOCAL_NAME, given);
      set(WD_FAMILY, EXCLUDE_LOCAL_NAME, family);
    } else if (given) {
      // 只有单段姓名：只写名，避免把整串姓名塞进 last name 槽
      set(WD_NAME, EXCLUDE_LOCAL_NAME, given);
    }
    set(WD_EMAIL, [], valueFor(values, 'email'));
    set(WD_PHONE, EXCLUDE_PHONE_NEIGHBOR, valueFor(values, 'phone'));
    set(['location', 'address'], [], valueFor(values, 'location'));
    // 求职信：Workday 自定义问题（Why/自我介绍类）在深层组件，data-automation-id 无统一键，
    // 保持按 label/文本宽松匹配（findLabeledQuestion 已覆盖 shadow DOM）。
    set(['cover letter', 'summary'], [], valueFor(values, 'cover_letter') ?? valueFor(values, 'summary'));
    // Workday 表单无 GitHub/LinkedIn 独立槽（由简历承载），明确不填
    void valueFor(values, 'github_url');
    void valueFor(values, 'linkedin_url');
    return written;
  },
};
