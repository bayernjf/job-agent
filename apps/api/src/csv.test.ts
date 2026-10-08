/**
 * CSV 序列化工具测试（B1-c 候选人清单导出，2026-10-08）。
 */
import { describe, expect, it } from 'vitest';
import { escapeCsvField, toCsv } from './csv.js';

describe('escapeCsvField', () => {
  it('passes plain values through untouched', () => {
    expect(escapeCsvField('alice')).toBe('alice');
    expect(escapeCsvField(42)).toBe('42');
  });

  it('emits an empty field for null/undefined', () => {
    expect(escapeCsvField(null)).toBe('');
    expect(escapeCsvField(undefined)).toBe('');
  });

  it('quotes fields containing commas, quotes or newlines and doubles inner quotes', () => {
    expect(escapeCsvField('a,b')).toBe('"a,b"');
    expect(escapeCsvField('say "hi"')).toBe('"say ""hi"""');
    expect(escapeCsvField('line1\nline2')).toBe('"line1\nline2"');
  });
});

describe('toCsv', () => {
  it('emits header plus rows joined by CRLF with a trailing newline', () => {
    const csv = toCsv(
      ['login', 'skills'],
      [
        ['alice', 'Rust, Go'],
        ['bob', ''],
      ],
    );
    expect(csv).toBe('login,skills\r\nalice,"Rust, Go"\r\nbob,\r\n');
  });
});
