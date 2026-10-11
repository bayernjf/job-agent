/**
 * AgentWorkbench 纯 helper 单测（求职工作台阶段 1）。
 *
 * 只测无 I/O 的纯函数：文件名 slug、下载文件名、模板占位替换、事件码→文案映射、事件流折叠。
 * 这些是"渲染侧只认 code"纪律的落点——匹配报告/事件流一律按 code 取本地化模板，
 * 所以这里钉住：① 未知码绝不静默编文案；② 占位符必须真被事实替换；③ 折叠只改显示、
 * 绝不丢事件（可回放审计流的完整性在显示层也要成立）。
 */
import { describe, expect, it } from 'vitest';
import type { JobRunEvent } from '@jobagent/shared';
import {
  eventKindLabel,
  fillTemplate,
  formatEventTime,
  groupRunEvents,
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

describe('groupRunEvents', () => {
  function ev(
    id: string,
    event: string,
    from: string | null,
    to: string,
    actor: string,
    at: string,
  ) {
    return { eventId: id, runId: 'run-1', event, fromStatus: from, toStatus: to, actor, payload: {}, createdAt: at } as unknown as JobRunEvent;
  }

  const rescan = (id: string, at: string) => ev(id, 'rescan', 'watching', 'watching', 'agent', at);

  it('folds consecutive identical transitions into one counted row', () => {
    const groups = groupRunEvents([
      rescan('e1', '2026-10-10T04:00:00.000Z'),
      rescan('e2', '2026-10-10T04:05:00.000Z'),
      rescan('e3', '2026-10-10T04:10:00.000Z'),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      count: 3,
      event: 'rescan',
      firstAt: '2026-10-10T04:00:00.000Z',
      lastAt: '2026-10-10T04:10:00.000Z',
    });
  });

  it('keeps the replay structure: only *adjacent* duplicates fold', () => {
    // 一次真实推进插在自迁移中间，前后两组自迁移不合并成一行
    const groups = groupRunEvents([
      rescan('e1', '2026-10-10T04:00:00.000Z'),
      ev('e2', 'candidates_ready', 'watching', 'awaiting_approval', 'agent', '2026-10-10T04:05:00.000Z'),
      rescan('e3', '2026-10-10T04:10:00.000Z'),
    ]);
    expect(groups.map((g) => [g.event, g.count])).toEqual([
      ['rescan', 1],
      ['candidates_ready', 1],
      ['rescan', 1],
    ]);
  });

  it('does not fold across a different transition or a different actor', () => {
    const groups = groupRunEvents([
      rescan('e1', '2026-10-10T04:00:00.000Z'),
      ev('e2', 'rescan', 'paused', 'watching', 'agent', '2026-10-10T04:05:00.000Z'),
      ev('e3', 'rescan', 'watching', 'watching', 'user', '2026-10-10T04:10:00.000Z'),
    ]);
    expect(groups).toHaveLength(3);
  });

  it('is display-only: folding never drops an event', () => {
    const events = Array.from({ length: 200 }, (_, i) => rescan(`e${i}`, '2026-10-10T04:00:00.000Z'));
    const groups = groupRunEvents(events);
    expect(groups).toHaveLength(1);
    expect(groups.reduce((sum, g) => sum + g.count, 0)).toBe(events.length);
  });
});
