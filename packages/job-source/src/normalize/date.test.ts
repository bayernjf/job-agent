import { describe, expect, it } from 'vitest';
import { epochToIso, textToIso, toPostedIso } from './date.js';

describe('epochToIso', () => {
  it('distinguishes seconds from milliseconds', () => {
    // 2026-09-01T00:00:00Z = 1788220800 (s) / 1788220800000 (ms)
    expect(epochToIso(1788220800)).toBe('2026-09-01T00:00:00.000Z');
    expect(epochToIso(1788220800000)).toBe('2026-09-01T00:00:00.000Z');
    expect(epochToIso(0)).toBeNull();
    expect(epochToIso('n/a')).toBeNull();
  });
});

describe('textToIso', () => {
  it('appends Z to timezone-less Remotive timestamps (treat as UTC)', () => {
    expect(textToIso('2026-09-11T06:49:00')).toBe('2026-09-11T06:49:00.000Z');
  });

  it('passes through already-offset ISO and rejects garbage', () => {
    expect(textToIso('2026-09-11T06:49:00Z')).toBe('2026-09-11T06:49:00.000Z');
    expect(textToIso('2026-09-11T06:49:00+02:00')).toBe('2026-09-11T04:49:00.000Z');
    expect(textToIso('not a date')).toBeNull();
    expect(textToIso('')).toBeNull();
  });
});

describe('toPostedIso', () => {
  it('falls back when value missing/invalid', () => {
    expect(toPostedIso(undefined, '2026-09-13T00:00:00.000Z')).toBe('2026-09-13T00:00:00.000Z');
    expect(toPostedIso('garbage', '2026-09-13T00:00:00.000Z')).toBe('2026-09-13T00:00:00.000Z');
    expect(toPostedIso(1788220800, 'fb')).toBe('2026-09-01T00:00:00.000Z');
  });
});
