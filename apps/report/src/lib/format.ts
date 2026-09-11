/**
 * 展示层格式化工具——日期/数字按 locale 走 Intl（i18n 设计第 5 节）。
 */

import type { Locale } from '../i18n/index.js';

const intlLocaleMap: Record<Locale, string> = {
  'zh-CN': 'zh-CN',
  en: 'en-US',
};

/** 格式化日期时间 */
export function formatDateTime(iso: string, locale: Locale): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat(intlLocaleMap[locale], {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }).format(date);
}

/** 格式化百分比（置信度 0-1 → 百分比） */
export function formatPercent(value: number, locale: Locale): string {
  return new Intl.NumberFormat(intlLocaleMap[locale], {
    style: 'percent',
    maximumFractionDigits: 0,
  }).format(value);
}

/** 格式化整数 */
export function formatNumber(value: number, locale: Locale): string {
  return new Intl.NumberFormat(intlLocaleMap[locale]).format(value);
}

/** 真实性状态对应的 CSS 修饰类 */
export function authenticityClass(status: string): string {
  switch (status) {
    case 'likely_authentic':
      return 'ja-badge--likely';
    case 'mixed_signals':
      return 'ja-badge--mixed';
    case 'suspicious':
      return 'ja-badge--suspicious';
    default:
      return 'ja-badge--insufficient';
  }
}
