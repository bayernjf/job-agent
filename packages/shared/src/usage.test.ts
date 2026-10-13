import { describe, expect, it } from 'vitest';
import {
  RecordUsageInputSchema,
  UsageDailyRowSchema,
  UsageSummaryQuerySchema,
  USAGE_BILLING_SOURCES,
  USAGE_CATEGORIES,
  USAGE_FEATURES,
} from './usage.js';

/**
 * 成本回采契约的 Zod 守门（决策 #25 ④ Wave A）：值域只在应用侧约束（DB 无 CHECK），
 * 所以 schema 本身就是防线——非法类别/负 token/坏日期格式必须在边界被拒。
 */
describe('RecordUsageInputSchema', () => {
  const valid = {
    accountId: 'acc-1',
    category: 'llm',
    feature: 'cover_letter',
    billingSource: 'builtin',
    provider: 'openai-compatible',
    model: 'gpt-x',
    promptTokens: 120,
    completionTokens: 45,
    quantity: null,
  };

  it('accepts a fully populated LLM event', () => {
    expect(RecordUsageInputSchema.parse(valid)).toMatchObject({
      category: 'llm',
      feature: 'cover_letter',
      billingSource: 'builtin',
      promptTokens: 120,
    });
  });

  it('accepts anonymous platform events with null accountId and omitted optionals', () => {
    const parsed = RecordUsageInputSchema.parse({
      accountId: null,
      category: 'search',
      feature: 'websearch',
      billingSource: 'platform',
      quantity: 3,
    });
    expect(parsed.accountId).toBeNull();
    expect(parsed.provider).toBeUndefined();
    expect(parsed.promptTokens).toBeUndefined();
  });

  it('rejects unknown category / feature / billingSource (value domain is app-side only)', () => {
    expect(() => RecordUsageInputSchema.parse({ ...valid, category: 'compute' })).toThrow();
    expect(() => RecordUsageInputSchema.parse({ ...valid, feature: 'polish' })).toThrow();
    expect(() => RecordUsageInputSchema.parse({ ...valid, billingSource: 'free' })).toThrow();
  });

  it('rejects negative or fractional token counts', () => {
    expect(() => RecordUsageInputSchema.parse({ ...valid, promptTokens: -1 })).toThrow();
    expect(() => RecordUsageInputSchema.parse({ ...valid, completionTokens: 1.5 })).toThrow();
    expect(() => RecordUsageInputSchema.parse({ ...valid, quantity: -2 })).toThrow();
  });

  it('keeps the three value domains aligned with their literal arrays', () => {
    expect(USAGE_CATEGORIES).toEqual(['llm', 'search', 'analysis']);
    expect(USAGE_FEATURES).toContain('jd_extraction');
    expect(USAGE_FEATURES).toContain('analysis_job');
    expect(USAGE_BILLING_SOURCES).toEqual(['builtin', 'byok', 'platform']);
  });
});

describe('UsageSummaryQuerySchema', () => {
  it('requires sinceIso and allows omitted until/account/category filters', () => {
    const parsed = UsageSummaryQuerySchema.parse({ sinceIso: '2026-10-01T00:00:00.000Z' });
    expect(parsed.untilIso).toBeUndefined();
    expect(parsed.accountId).toBeUndefined();
    expect(parsed.category).toBeUndefined();
  });

  it('rejects a missing sinceIso (window must be explicit, never a full-table scan)', () => {
    expect(() => UsageSummaryQuerySchema.parse({})).toThrow();
  });
});

describe('UsageDailyRowSchema', () => {
  it('enforces the YYYY-MM-DD day bucket format', () => {
    const row = {
      day: '2026-10-14',
      category: 'llm',
      events: 2,
      sumPromptTokens: 10,
      sumCompletionTokens: 5,
      sumQuantity: 0,
    };
    expect(UsageDailyRowSchema.parse(row)).toMatchObject({ day: '2026-10-14' });
    expect(() =>
      UsageDailyRowSchema.parse({ ...row, day: '2026-10-14T00:00:00.000Z' }),
    ).toThrow();
  });
});
