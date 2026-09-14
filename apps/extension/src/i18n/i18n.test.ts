/**
 * 扩展 i18n 一致性与行为测试（design-i18n-20260910.md 第 3、8 节）：
 * 1. zh-CN 与 en 的 key 集合完全相等
 * 2. 无空串、占位符一致、key 命名规范
 * 3. en 不得残留中文（语言切换器文案白名单除外）
 * 4. translate / detectLocale / resolveLocale 行为
 */
import { describe, expect, it } from 'vitest';
import zhCN from './messages/zh-CN.json';
import en from './messages/en.json';
import {
  DEFAULT_LOCALE,
  LOCALE_STORAGE_KEY,
  createTranslator,
  detectLocale,
  isLocale,
  resolveLocale,
  translate,
} from './index.js';

function extractPlaceholders(text: string): string[] {
  return (text.match(/\{(\w+)\}/g) ?? []).sort();
}

describe('i18n key alignment', () => {
  const zhKeys = Object.keys(zhCN).sort();
  const enKeys = Object.keys(en).sort();

  it('zh-CN and en have identical key sets', () => {
    expect(enKeys).toEqual(zhKeys);
  });

  it('has no empty values', () => {
    for (const [key, value] of Object.entries(zhCN)) {
      expect(value.trim().length, `zh-CN key "${key}" is empty`).toBeGreaterThan(0);
    }
    for (const [key, value] of Object.entries(en)) {
      expect(value.trim().length, `en key "${key}" is empty`).toBeGreaterThan(0);
    }
  });

  it('has consistent interpolation placeholders', () => {
    for (const key of zhKeys) {
      expect(
        extractPlaceholders(en[key as keyof typeof en]),
        `placeholder mismatch for "${key}"`,
      ).toEqual(extractPlaceholders(zhCN[key as keyof typeof zhCN]));
    }
  });

  it('every key follows dotted.namespace convention', () => {
    const keyPattern = /^[a-z][a-zA-Z0-9]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/;
    for (const key of zhKeys) {
      expect(keyPattern.test(key), `bad key naming: "${key}"`).toBe(true);
    }
  });

  it('en values contain no CJK characters except the language-switcher label', () => {
    const cjk = /[一-鿿]/;
    const allowlist = new Set(['nav.language']);
    for (const [key, value] of Object.entries(en)) {
      if (allowlist.has(key)) continue;
      expect(cjk.test(value), `en "${key}" still contains Chinese: ${value}`).toBe(false);
    }
  });
});

describe('translate', () => {
  it('translates in both locales', () => {
    expect(translate('zh-CN', 'panel.fill')).toBe('填充到表单');
    expect(translate('en', 'panel.fill')).toBe('Fill the form');
  });

  it('interpolates parameters', () => {
    expect(translate('en', 'panel.filledNote', { count: 3 })).toBe(
      'Filled 3 field(s); complete any remaining fields manually.',
    );
    expect(translate('zh-CN', 'panel.atsLabel', { name: 'Lever' })).toBe('ATS：Lever');
  });

  it('keeps an unmatched placeholder intact instead of crashing', () => {
    expect(translate('en', 'panel.filledNote')).toContain('{count}');
  });

  it('returns a visible missing marker for an unknown key', () => {
    expect(translate('en', 'does.not.exist' as never)).toBe('[missing: does.not.exist]');
  });

  it('createTranslator binds a locale', () => {
    const t = createTranslator('zh-CN');
    expect(t('panel.analyze')).toBe('获取可信画像');
  });
});

describe('language detection (no URL segment in extension)', () => {
  it('detects Chinese / English browser languages', () => {
    expect(detectLocale(['zh-CN', 'zh'])).toBe('zh-CN');
    expect(detectLocale(['zh-TW'])).toBe('zh-CN');
    expect(detectLocale(['en-US', 'en'])).toBe('en');
  });

  it('falls back to en for unsupported or empty language lists', () => {
    expect(detectLocale(['fr-FR', 'de-DE'])).toBe(DEFAULT_LOCALE);
    expect(detectLocale([])).toBe(DEFAULT_LOCALE);
    expect(detectLocale(null)).toBe(DEFAULT_LOCALE);
    expect(detectLocale(undefined)).toBe(DEFAULT_LOCALE);
  });

  it('resolveLocale prefers the stored choice over navigator languages', () => {
    expect(resolveLocale('en', ['zh-CN'])).toBe('en');
    expect(resolveLocale('zh-CN', ['en-US'])).toBe('zh-CN');
    expect(resolveLocale(null, ['zh-CN'])).toBe('zh-CN');
    expect(resolveLocale('bad-value', ['en-US'])).toBe('en');
    expect(resolveLocale(undefined, undefined)).toBe(DEFAULT_LOCALE);
  });

  it('isLocale guards stored values', () => {
    expect(isLocale('zh-CN')).toBe(true);
    expect(isLocale('en')).toBe(true);
    expect(isLocale('zh_TW')).toBe(false);
    expect(isLocale(null)).toBe(false);
  });

  it('exposes a stable localStorage key', () => {
    expect(LOCALE_STORAGE_KEY).toBe('jobagent.locale');
  });
});
