/**
 * ResumeBuilder 纯 helper 单测（审查动作 #9：report 测试比 0.25 全仓最弱）。
 * 只测无 I/O 的投影/文件名逻辑，不挂载组件。
 */
import { describe, expect, it } from 'vitest';
import { slug, toResumeRequest } from './ResumeBuilder.tsx';

describe('toResumeRequest', () => {
  it('returns undefined when every projected field is empty', () => {
    expect(toResumeRequest({})).toBeUndefined();
  });

  it('projects canonical local fields into the resume request shape', () => {
    const projected = toResumeRequest({ fullName: 'Alice Chen', email: 'alice@example.com' });
    expect(projected).toMatchObject({ fullName: 'Alice Chen', email: 'alice@example.com' });
  });

  it('keeps a single populated field even when the rest are empty', () => {
    const projected = toResumeRequest({ phone: '+86 138 0000 0000' });
    expect(projected?.phone).toBe('+86 138 0000 0000');
  });
});

describe('slug', () => {
  it('lowercases and hyphenates punctuation/whitespace', () => {
    expect(slug('Acme Corp. — Backend / Platform')).toBe('acme-corp-backend-platform');
  });

  it('falls back to a stable token when nothing survives', () => {
    expect(slug('后端工程师')).toBe('resume');
    expect(slug('')).toBe('resume');
  });
});
