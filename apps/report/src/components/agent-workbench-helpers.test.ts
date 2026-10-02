/**
 * AgentWorkbench 纯 helper 单测（求职工作台阶段 1）。
 *
 * 只测无 I/O 的纯函数：文件名 slug、下载文件名、模板占位替换、事件码→文案映射。
 * 这些是"渲染侧只认 code"纪律的落点——匹配报告/事件流一律按 code 取本地化模板，
 * 所以这里钉住：① 未知码绝不静默编文案；② 占位符必须真被事实替换。
 */
import { describe, expect, it } from 'vitest';
import {
  eventKindLabel,
  fillTemplate,
  formatEventTime,
  intentFileName,
  slugify,
} from './AgentWorkbench.tsx';

describe('slugify', () => {
  it('lowercases and hyphenates non-alphanumerics', () => {
    expect(slugify('Acme Corp.')).toBe('acme-corp');
    expect(slugify('Senior TypeScript Engineer')).toBe('senior-typescript-engineer');
  });

  it('trims leading and trailing separators', () => {
    expect(slugify('  — Backend / Platform —  ')).toBe('backend-platform');
  });

  it('falls back to a non-empty token when nothing survives', () => {
    expect(slugify('后端工程师')).toBe('job');
    expect(slugify('')).toBe('job');
  });
});

describe('intentFileName', () => {
  const intent = {
    job: { company: 'Acme Corp', title: 'Senior TypeScript Engineer' },
  } as unknown as Parameters<typeof intentFileName>[0];

  it('builds <company>-<title>.md', () => {
    expect(intentFileName(intent)).toBe('acme-corp-senior-typescript-engineer.md');
  });

  it('appends a suffix before the extension for the cover letter', () => {
    expect(intentFileName(intent, '-cover-letter')).toBe(
      'acme-corp-senior-typescript-engineer-cover-letter.md',
    );
  });
});

describe('fillTemplate', () => {
  it('replaces every occurrence of a placeholder with the fact', () => {
    expect(
      fillTemplate('Job title matches "{skill}" {points}', {
        skill: 'TypeScript',
        points: '+3 points',
      }),
    ).toBe('Job title matches "TypeScript" +3 points');
  });

  it('keeps placeholders it has no fact for (never invents one)', () => {
    expect(fillTemplate('{a} and {b}', { a: 'X' })).toBe('X and {b}');
  });
});

describe('eventKindLabel', () => {
  const dict = { candidatesReady: 'Candidates ready', cancel: 'Cancelled by user' };

  it('maps the snake_case contract code to its camelCase label key', () => {
    expect(eventKindLabel('candidates_ready', dict)).toBe('Candidates ready');
    expect(eventKindLabel('cancel', dict)).toBe('Cancelled by user');
  });

  it('falls back to the raw code when the dictionary has no entry', () => {
    expect(eventKindLabel('generated', dict)).toBe('generated');
  });
});

describe('formatEventTime', () => {
  it('renders a non-empty label for a valid ISO timestamp', () => {
    expect(formatEventTime('2026-10-02T08:30:00.000Z', 'en').length).toBeGreaterThan(0);
    expect(formatEventTime('2026-10-02T08:30:00.000Z', 'zh-CN').length).toBeGreaterThan(0);
  });

  it('falls back to the raw string instead of printing "Invalid Date"', () => {
    expect(formatEventTime('not-a-date', 'en')).toBe('not-a-date');
  });
});
