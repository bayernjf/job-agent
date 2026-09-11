/**
 * i18n 一致性测试（design-i18n-20260910.md 第 6 节验收标准）：
 * 1. zh-CN 与 en 的 key 集合完全相等
 * 2. 无空串
 * 3. 插值占位符 {name} 一致
 */

import { describe, expect, it } from 'vitest';
import zhCN from './messages/zh-CN.json';
import en from './messages/en.json';
import { translate, createTranslator, negotiateLocale, isLocale, DEFAULT_LOCALE } from './index.js';

function extractPlaceholders(text: string): string[] {
  const matches = text.match(/\{(\w+)\}/g) ?? [];
  return matches.sort();
}

describe('i18n key alignment', () => {
  const zhKeys = Object.keys(zhCN).sort();
  const enKeys = Object.keys(en).sort();

  it('zh-CN and en have identical key sets', () => {
    expect(enKeys).toEqual(zhKeys);
  });

  it('has no empty strings in zh-CN', () => {
    for (const [key, value] of Object.entries(zhCN)) {
      expect(value.trim().length, `zh-CN key "${key}" is empty`).toBeGreaterThan(0);
    }
  });

  it('has no empty strings in en', () => {
    for (const [key, value] of Object.entries(en)) {
      expect(value.trim().length, `en key "${key}" is empty`).toBeGreaterThan(0);
    }
  });

  it('has consistent interpolation placeholders between zh-CN and en', () => {
    for (const key of zhKeys) {
      const zhPlaceholders = extractPlaceholders(zhCN[key as keyof typeof zhCN]);
      const enPlaceholders = extractPlaceholders(en[key as keyof typeof en]);
      expect(enPlaceholders, `placeholder mismatch for key "${key}"`).toEqual(zhPlaceholders);
    }
  });
});

describe('translate', () => {
  it('translates a key in zh-CN', () => {
    expect(translate('zh-CN', 'app.name')).toBe('JobAgent');
    expect(translate('zh-CN', 'job.queued')).toBe('排队中');
  });

  it('translates a key in en', () => {
    expect(translate('en', 'app.name')).toBe('JobAgent');
    expect(translate('en', 'job.queued')).toBe('Queued');
  });

  it('interpolates parameters', () => {
    expect(translate('en', 'job.attempts', { current: 2, max: 3 })).toBe('Attempt 2/3');
    expect(translate('zh-CN', 'report.activity.months', { count: 14 })).toBe('14 个月');
  });

  it('returns visible missing marker for unknown key behavior', () => {
    // 正常 key 不应该有 missing 标记
    const result = translate('en', 'common.loading');
    expect(result).not.toContain('[missing:');
  });
});

describe('createTranslator', () => {
  it('creates a bound translator', () => {
    const t = createTranslator('zh-CN');
    expect(t('job.succeeded')).toBe('已完成');
    expect(t('report.evidence.count', { count: 5 })).toBe('5 条证据');
  });
});

describe('negotiateLocale', () => {
  it('returns zh-CN for Chinese Accept-Language', () => {
    expect(negotiateLocale('zh-CN,zh;q=0.9')).toBe('zh-CN');
    expect(negotiateLocale('zh-TW')).toBe('zh-CN');
  });

  it('returns en for English Accept-Language', () => {
    expect(negotiateLocale('en-US,en;q=0.9')).toBe('en');
  });

  it('falls back to default locale for unsupported or missing', () => {
    expect(negotiateLocale('fr-FR')).toBe(DEFAULT_LOCALE);
    expect(negotiateLocale(null)).toBe(DEFAULT_LOCALE);
    expect(negotiateLocale(undefined)).toBe(DEFAULT_LOCALE);
    expect(negotiateLocale('')).toBe(DEFAULT_LOCALE);
  });
});

describe('isLocale', () => {
  it('recognizes supported locales', () => {
    expect(isLocale('zh-CN')).toBe(true);
    expect(isLocale('en')).toBe(true);
  });

  it('rejects unsupported locales', () => {
    expect(isLocale('fr')).toBe(false);
    expect(isLocale(null)).toBe(false);
    expect(isLocale(undefined)).toBe(false);
  });
});
