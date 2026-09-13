import { describe, expect, it } from 'vitest';
import { parseSalaryText, nullifyZero } from './salary.js';

describe('parseSalaryText', () => {
  it('parses K-suffixed USD ranges (Remotive style)', () => {
    expect(parseSalaryText('$10K-$20K')).toEqual({ min: 10_000, max: 20_000, currency: 'USD' });
    expect(parseSalaryText('OTE $25k - $35k')).toEqual({ min: 25_000, max: 35_000, currency: 'USD' });
  });

  it('parses comma thousands and single value', () => {
    expect(parseSalaryText('$120,000 - $150,000')).toEqual({ min: 120_000, max: 150_000, currency: 'USD' });
    expect(parseSalaryText('$90K')).toEqual({ min: 90_000, max: 90_000, currency: 'USD' });
  });

  it('returns null numbers for empty/unparseable text', () => {
    expect(parseSalaryText('')).toEqual({ min: null, max: null, currency: null });
    expect(parseSalaryText('Competitive salary')).toEqual({ min: null, max: null, currency: null });
  });

  it('keeps non-USD currency but drops numbers (no FX guessing)', () => {
    expect(parseSalaryText('€60K-€80K')).toEqual({ min: null, max: null, currency: 'EUR' });
  });
});

describe('nullifyZero', () => {
  it('treats 0 and invalid as missing', () => {
    expect(nullifyZero(0)).toBeNull();
    expect(nullifyZero('abc')).toBeNull();
    expect(nullifyZero(120000)).toBe(120000);
  });
});
