/**
 * 扩展侧轻量 i18n（docs/design-i18n-20260910.md 第 8 节）。
 *
 * 契约与 apps/report 一致（字典独立、不共享 key）：
 * - zh-CN.json 是单一事实源，MessageKey 从中推导
 * - en.json 必须覆盖全部 key（Record<MessageKey, string>，缺 key 编译报错）
 * - 插值用 {name} 占位符；缺 key 渲染可见 [missing: key]，绝不静默回落
 *
 * 与报告页差异：扩展没有 URL 语言段，语言 = 用户显式选择（localStorage，
 * 由调用方读写）优先，否则按 navigator.languages 协商；本模块不碰 DOM，便于单测。
 */

import zhCN from './messages/zh-CN.json';
import en from './messages/en.json';

export const locales = ['zh-CN', 'en'] as const;
export type Locale = (typeof locales)[number];

/** key 类型从中文单一事实源推导 */
export type MessageKey = keyof typeof zhCN;

/** localStorage 中保存用户显式语言选择的键 */
export const LOCALE_STORAGE_KEY = 'jobagent.locale';

/** 英文字典必须与中文 key 集合完全对齐，缺 key 时 tsc 直接报错 */
const enDict: Record<MessageKey, string> = en;
const zhDict: Record<MessageKey, string> = zhCN;

const dictionaries: Record<Locale, Record<MessageKey, string>> = {
  'zh-CN': zhDict,
  en: enDict,
};

/** 默认语言回落（协商失败时用 en，海外优先） */
export const DEFAULT_LOCALE: Locale = 'en';

/** 判断字符串是否为支持的语言标识 */
export function isLocale(value: string | undefined | null): value is Locale {
  return value === 'zh-CN' || value === 'en';
}

/**
 * 从浏览器语言列表协商语言（无 Accept-Language/URL 通道场景）：
 * zh* → zh-CN，en* → en，其余/空 → en。
 */
export function detectLocale(acceptedLanguages: readonly string[] | null | undefined): Locale {
  if (!acceptedLanguages || acceptedLanguages.length === 0) return DEFAULT_LOCALE;
  for (const raw of acceptedLanguages) {
    const lowered = raw.toLowerCase();
    if (lowered.startsWith('zh')) return 'zh-CN';
    if (lowered.startsWith('en')) return 'en';
  }
  return DEFAULT_LOCALE;
}

/**
 * 解析最终语言：用户显式存储值优先，其次浏览器语言列表，最后回落 en。
 * @param storedLocale localStorage 读出的原始值
 * @param navLanguages navigator.languages（测试可注入）
 */
export function resolveLocale(
  storedLocale: string | null | undefined,
  navLanguages: readonly string[] | null | undefined,
): Locale {
  if (isLocale(storedLocale)) return storedLocale;
  return detectLocale(navLanguages);
}

/** 替换 {name} 占位符 */
function interpolate(template: string, params?: Record<string, string | number>): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, key: string) => {
    if (key in params) return String(params[key]);
    return match;
  });
}

/** 翻译函数：locale + key + 可选插值参数 */
export function translate(
  locale: Locale,
  key: MessageKey,
  params?: Record<string, string | number>,
): string {
  const dict = dictionaries[locale];
  const value = dict[key];
  if (value === undefined || value === '') {
    // 可见缺失标记，绝不静默回落另一语言
    return `[missing: ${key}]`;
  }
  return interpolate(value, params);
}

/** 创建绑定 locale 的 t() 函数（组件里用） */
export function createTranslator(locale: Locale) {
  return (key: MessageKey, params?: Record<string, string | number>): string =>
    translate(locale, key, params);
}

export type Translator = ReturnType<typeof createTranslator>;
