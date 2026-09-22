/**
 * ATS 适配器层：识别当前页面属于哪个招聘系统，把可信画像 + 本地补填
 * 映射为表单字段值并写入页面。
 *
 * 差异化（决策 #15）：填充数据来自 GitHub 验证过的画像（ExportableProfile），
 * 区别于"更快投出你编的简历"的普通填充工具；skills 保留 evidenceRefs 可回溯。
 *
 * MVP 范围：Greenhouse / Lever / Workday 三大 ATS，仅用户主动触发（点击面板"填充"）。
 */

import type { ExportableProfile, LocalAtsFields } from '@jobagent/shared';
import { greenhouseAdapter } from './greenhouse.js';
import { leverAdapter } from './lever.js';
import { workdayAdapter } from './workday.js';

/**
 * 用户在面板里本地补填的信息（画像没有的字段，仅存本机 localStorage）。
 * 自 item19 ① 起统一为 shared canonical 的 ATS 投影形状 LocalAtsFields；
 * 面板编辑/存储 canonical LocalProfileFields，填充前经 localProfileToAtsFields 投影。
 */
export type LocalFields = LocalAtsFields;

/** 语义化表单值（各 ATS 的 fill 再映射到具体 DOM） */
export interface FillValue {
  key:
    | 'full_name'
    | 'email'
    | 'phone'
    | 'location'
    | 'headline'
    | 'summary'
    | 'github_url'
    | 'linkedin_url'
    | 'personal_website_url'
    | 'skills'
    | 'education'
    | 'experience';
  value: string;
}

export interface AtsAdapter {
  id: 'greenhouse' | 'lever' | 'workday';
  name: string;
  /** 当前页面是否为该 ATS 的应用表单页 */
  detect(doc: Document): boolean;
  /** 画像 + 本地补填 → 语义化表单值（纯函数，便于单测） */
  mapFields(profile: ExportableProfile, local: LocalFields): FillValue[];
  /** 把语义化值写入页面表单元素；返回成功写入的字段数 */
  fill(doc: Document, values: FillValue[]): number;
}

/**
 * summary 中面向招聘方可见的组装文案，由 UI 层用 i18n 生成后注入；
 * ats 层不依赖 i18n。缺省保留原中文，兼容既有纯函数调用与单测。
 */
export interface FillSummaryLabels {
  skillsLeadin?: string;
  skillSeparator?: string;
}

/** 画像 + 本地补填 → 通用语义值（三适配器共享，差异化逻辑集中在此） */
export function toFillValues(
  profile: ExportableProfile,
  local: LocalFields,
  labels: FillSummaryLabels = {},
): FillValue[] {
  const platformLabel = profile.subject.platform === 'gitee' ? 'Gitee' : 'GitHub';
  const skillsLeadin = labels.skillsLeadin ?? `技能（${platformLabel} 验证，可回溯证据）：`;
  const skillSeparator = labels.skillSeparator ?? '、';
  const values: FillValue[] = [];
  const fullName = profile.subject.displayName ?? profile.subject.login;
  values.push({ key: 'full_name', value: fullName });
  values.push({ key: 'github_url', value: profile.subject.profileUrl });
  values.push({ key: 'headline', value: profile.headline });
  values.push({
    key: 'summary',
    value: `${profile.headline}\n\n${skillsLeadin}${profile.skills
      .map((s) => `${s.name} (${s.confidence})`)
      .join(skillSeparator)}`,
  });
  values.push({ key: 'skills', value: profile.skills.map((s) => s.name).join(', ') });
  if (local.email) values.push({ key: 'email', value: local.email });
  if (local.phone) values.push({ key: 'phone', value: local.phone });
  if (local.location) values.push({ key: 'location', value: local.location });
  if (local.linkedinUrl) values.push({ key: 'linkedin_url', value: local.linkedinUrl });
  if (local.personalWebsite) values.push({ key: 'personal_website_url', value: local.personalWebsite });
  if (local.education?.length) {
    values.push({
      key: 'education',
      value: local.education
        .map((e) => [e.school, e.degree, e.start && e.end ? `${e.start}–${e.end}` : ''].filter(Boolean).join(', '))
        .join('\n'),
    });
  }
  if (local.experience?.length) {
    values.push({
      key: 'experience',
      value: local.experience
        .map((e) => [e.company, e.title, e.start && e.end ? `${e.start}–${e.end}` : ''].filter(Boolean).join(', '))
        .join('\n'),
    });
  }
  return values;
}

const ADAPTERS: readonly AtsAdapter[] = [greenhouseAdapter, leverAdapter, workdayAdapter];

export function detectAts(doc: Document): AtsAdapter | null {
  return ADAPTERS.find((a) => a.detect(doc)) ?? null;
}

export function listAdapters(): readonly AtsAdapter[] {
  return ADAPTERS;
}

/** 收集当前文档及其同源 iframe 内的 document（Greenhouse job-boards 等 SPA 表单在 iframe 中） */
function allDocuments(doc: Document): Document[] {
  const docs: Document[] = [doc];
  for (const frame of Array.from(doc.querySelectorAll('iframe'))) {
    try {
      const fd = frame.contentDocument;
      if (fd && !docs.includes(fd)) docs.push(fd);
    } catch {
      // 跨域 iframe 无法访问，跳过
    }
  }
  return docs;
}

/** 递归收集 root（Document/ShadowRoot）内的可填字段，含嵌套 shadow DOM（Workday 全组件化表单） */
function collectFields(root: Document | ShadowRoot): Array<HTMLInputElement | HTMLTextAreaElement> {
  // Real Lever forms render phone as type="tel" and LinkedIn/GitHub/website as type="url";
  // both must be collected or keyword matching can never fill them.
  const fields = Array.from(
    root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
      'input[type="text"], input[type="email"], input[type="tel"], input[type="url"], input:not([type]), textarea',
    ),
  );
  for (const el of Array.from(root.querySelectorAll('*'))) {
    if (el.shadowRoot) fields.push(...collectFields(el.shadowRoot));
  }
  return fields;
}

/** 归一化：小写 + 下划线/连字符/空格统一为空格（匹配 "first_name" ↔ "First name" 等变体） */
export function norm(s: string): string {
  return s.toLowerCase().replace(/[_\-\s]+/g, ' ').trim();
}

/** 可接受画像 summary 的自定义问题文本关键词（归一化后命中任一即写入） */
export const SUMMARY_HINTS = [
  'why',
  'cover letter',
  'about yourself',
  'tell us',
  'interest',
  'motivat',
  'summary',
  'introduce',
  'relevant experience',
  'additional',
  // 真实 Greenhouse/Lever 自定义问题常见措辞（2026-09-18 扩充，均为自我陈述/动机/补充类
  // 自由文本；刻意不含薪资、授权、引流（how did you hear）、链接（portfolio/LinkedIn URL）、
  // 年限数字类问题，避免把 summary 写进短答案/URL 字段）
  'anything else',
  'what makes you',
  'describe yourself',
  'about you',
  'your background',
  'describe your experience',
  'in your own words',
];

/**
 * 通用 DOM 定位：按 input/textarea 的 name/id/aria-label/placeholder 关键字匹配（含 iframe 与 shadow DOM）。
 * exclude（可选）为排除关键字：归一化后命中任一排除词的字段直接跳过，用于区分同名近邻字段
 * （例如 Greenhouse 电话分组里的 Country/区号框 name 含 country，不能与 Location (City) 混淆）。
 */
export function findFields(
  doc: Document,
  keywords: string[],
  exclude: string[] = [],
): HTMLInputElement[] {
  const hit = new Set<HTMLInputElement | HTMLTextAreaElement>();
  const normExclude = exclude.map(norm);
  for (const d of allDocuments(doc)) {
    for (const el of collectFields(d)) {
      const hay = [
        norm(el.name),
        norm(el.getAttribute('id') ?? ''),
        norm(el.getAttribute('aria-label') ?? ''),
        norm(el.placeholder),
      ].join(' ');
      const includesKeyword = keywords.some((k) => hay.includes(norm(k)));
      const includesExcluded = normExclude.some((x) => hay.includes(x));
      if (includesKeyword && !includesExcluded) {
        hit.add(el);
      }
    }
  }
  return [...hit] as HTMLInputElement[];
}

/**
 * 定位 ATS 自定义问题中的自由文本字段（Greenhouse question_/answers[*]、Lever questions[...]），
 * 取关联问题文本（label[for=id] > aria-label > 就近 label），命中 summary 类关键词即返回。
 * id 形如 question_<uuid>/question_<数字>（字母数字-_），无需 CSS 转义。
 */
export function findLabeledQuestion(
  doc: Document,
  fieldPattern: RegExp,
): HTMLTextAreaElement | HTMLInputElement | null {
  for (const d of allDocuments(doc)) {
    for (const el of collectFields(d)) {
      if (!fieldPattern.test(el.name) && !fieldPattern.test(el.id)) continue;
      let labelText = '';
      if (el.id) {
        labelText = d.querySelector(`label[for="${el.id}"]`)?.textContent ?? '';
      }
      if (!labelText) labelText = el.getAttribute('aria-label') ?? '';
      if (!labelText) {
        // Flat forms (real Lever included) place the <label> as the immediate
        // preceding sibling with no wrapper; that is more precise than the
        // container's first label (which may be an unrelated field such as name).
        const prev = el.previousElementSibling;
        if (prev && prev.tagName === 'LABEL') labelText = prev.textContent ?? '';
      }
      if (!labelText) {
        const host = el.closest?.('div, fieldset, section');
        labelText = host?.querySelector('label')?.textContent ?? '';
      }
      if (SUMMARY_HINTS.some((hint) => norm(labelText).includes(hint))) {
        return el;
      }
    }
  }
  return null;
}

/** 按语义键取单个值（fill 用） */
export function valueFor(values: FillValue[], key: FillValue['key']): string | undefined {
  return values.find((v) => v.key === key)?.value;
}
