/**
 * RecruiterPostings 纯 helper 单测（审查动作 #9）。
 * 钉住两个展示层输入边界：非法时间不崩、标签去重与数量上限。
 */
import { describe, expect, it } from 'vitest';
import { formatWhen, parseTags } from './RecruiterPostings.tsx';

describe('formatWhen', () => {
  it('formats a valid ISO timestamp for the reader locale', () => {
    const en = formatWhen('2026-10-14T09:30:00.000Z', 'en');
    expect(en).toContain('2026');
    expect(en.length).toBeGreaterThan(4);
  });

  it('returns the raw input when the timestamp is invalid', () => {
    expect(formatWhen('not-a-date', 'en')).toBe('not-a-date');
  });
});

describe('parseTags', () => {
  it('trims, drops empties and de-duplicates', () => {
    expect(parseTags(' react, typescript ,, react , node ')).toEqual([
      'react',
      'typescript',
      'node',
    ]);
  });

  it('preserves first-seen order and caps the list at 25', () => {
    const raw = Array.from({ length: 30 }, (_, i) => `tag-${i}`).join(',');
    const tags = parseTags(raw);
    expect(tags).toHaveLength(25);
    expect(tags[0]).toBe('tag-0');
    expect(tags[24]).toBe('tag-24');
  });

  it('treats a comma-only input as empty', () => {
    expect(parseTags(' , , ')).toEqual([]);
  });
});
