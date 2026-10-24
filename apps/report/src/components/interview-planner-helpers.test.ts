/**
 * InterviewPlanner 纯 helper 单测（审查动作 #9）。
 * 覆盖展示格式化、datetime-local → UTC 的时区转换，以及"哪些投递可推进为面试"。
 */
import { describe, expect, it } from 'vitest';
import {
  BUILDABLE_STATUSES,
  formatDateTime,
  localInputToIso,
} from './InterviewPlanner.tsx';

describe('formatDateTime', () => {
  it('formats a valid ISO timestamp for zh-CN and en', () => {
    const zh = formatDateTime('2026-10-14T09:30:00.000Z', 'zh-CN');
    const en = formatDateTime('2026-10-14T09:30:00.000Z', 'en');
    expect(zh.length).toBeGreaterThan(0);
    expect(en.length).toBeGreaterThan(0);
    expect(zh).not.toBe(en);
  });
});

describe('localInputToIso', () => {
  it('converts a datetime-local value to UTC ISO8601', () => {
    const iso = localInputToIso('2026-10-14T09:30');
    expect(iso).toBe(new Date('2026-10-14T09:30').toISOString());
    expect(iso.endsWith('Z')).toBe(true);
  });
});

describe('BUILDABLE_STATUSES', () => {
  it('allows only early application stages to become interviews', () => {
    expect([...BUILDABLE_STATUSES].sort()).toEqual(['applied', 'saved', 'viewed']);
    // 终态不得回退为面试（与 API 状态机一致）
    for (const terminal of ['interview', 'offer', 'rejected', 'withdrawn']) {
      expect(BUILDABLE_STATUSES.has(terminal)).toBe(false);
    }
  });
});
