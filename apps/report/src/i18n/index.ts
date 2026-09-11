/**
 * i18n 轻量自研方案（design-i18n-20260910.md）。
 *
 * - zh-CN.json 是单一事实源，MessageKey 类型从中推导
 * - en.json 必须覆盖全部 key（Record<MessageKey, string>，缺 key 编译报错）
 * - 插值用 {name} 占位符
 * - 缺失文案渲染 [missing: key] 可见标记，绝不静默回落
 */

import zhCN from './messages/zh-CN.json';
import en from './messages/en.json';

export const locales = ['zh-CN', 'en'] as const;
export type Locale = (typeof locales)[number];

/** key 类型从中文单一事实源推导 */
export type MessageKey = keyof typeof zhCN;

/** 英文字典必须与中文 key 集合完全对齐，缺 key 时 tsc 直接报错 */
const enDict: Record<MessageKey, string> = en;
const zhDict: Record<MessageKey, string> = zhCN;

const dictionaries: Record<Locale, Record<MessageKey, string>> = {
  'zh-CN': zhDict,
  en: enDict,
};

/** 默认语言回落（Accept-Language 协商失败时用 en，海外优先） */
export const DEFAULT_LOCALE: Locale = 'en';

/** 判断字符串是否为支持的语言标识 */
export function isLocale(value: string | undefined | null): value is Locale {
  return value === 'zh-CN' || value === 'en';
}

/** 从 Accept-Language 头协商语言，失败回落 en */
export function negotiateLocale(acceptLanguage: string | null | undefined): Locale {
  if (!acceptLanguage) return DEFAULT_LOCALE;
  // 简单匹配：优先精确匹配，其次前缀匹配
  const lowered = acceptLanguage.toLowerCase();
  if (lowered.startsWith('zh')) return 'zh-CN';
  if (lowered.startsWith('en')) return 'en';
  return DEFAULT_LOCALE;
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
