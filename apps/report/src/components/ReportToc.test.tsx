// @vitest-environment jsdom
import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import ReportToc, { type ReportTocItem } from './ReportToc';

const items: ReportTocItem[] = [
  { id: 'section-summary', label: 'Summary' },
  { id: 'section-authenticity', label: 'Authenticity' },
  { id: 'section-skills', label: 'Skill Tags' },
];

/**
 * jsdom 无 IntersectionObserver；用可手动触发回调的假观察器，
 * 让单测能模拟「章节滚入判定带」这一真实浏览器事件。
 */
let ioCallback: IntersectionObserverCallback | null = null;
let ioOptions: IntersectionObserverInit | null = null;

class FakeIntersectionObserver {
  constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
    ioCallback = callback;
    ioOptions = options ?? null;
  }
  observe() {}
  unobserve() {}
  disconnect() {}
}

function entryFor(id: string, top: number, isIntersecting = true): IntersectionObserverEntry {
  return {
    isIntersecting,
    boundingClientRect: { top },
    target: document.getElementById(id)!,
  } as unknown as IntersectionObserverEntry;
}

function mountSectionStubs() {
  for (const item of items) {
    const div = document.createElement('div');
    div.id = item.id;
    document.body.appendChild(div);
  }
}

describe('ReportToc', () => {
  beforeEach(() => {
    ioCallback = null;
    ioOptions = null;
    globalThis.IntersectionObserver =
      FakeIntersectionObserver as unknown as typeof IntersectionObserver;
    mountSectionStubs();
  });

  afterEach(() => {
    // 清掉手工插入的章节桩节点（React 渲染的 nav 由 RTL 自动 cleanup）
    for (const item of items) document.getElementById(item.id)?.remove();
  });

  it('renders one anchor per item with the correct href and aria-current on first item', () => {
    render(<ReportToc items={items} ariaLabel="On this page" />);
    expect(screen.getByRole('navigation', { name: 'On this page' })).toBeInTheDocument();
    for (const item of items) {
      const link = screen.getByRole('link', { name: item.label });
      expect(link).toHaveAttribute('href', `#${item.id}`);
    }
    const first = screen.getByRole('link', { name: items[0].label });
    expect(first).toHaveAttribute('aria-current', 'true');
  });

  it('returns null when the item list is empty', () => {
    const { container } = render(<ReportToc items={[]} ariaLabel="On this page" />);
    expect(container.firstChild).toBeNull();
  });

  it('highlights the clicked anchor immediately (click callback), moving aria-current', () => {
    render(<ReportToc items={items} ariaLabel="On this page" />);
    const first = screen.getByRole('link', { name: items[0].label });
    const skills = screen.getByRole('link', { name: items[2].label });
    expect(first).toHaveClass('is-active');

    fireEvent.click(skills);

    expect(skills).toHaveClass('is-active');
    expect(skills).toHaveAttribute('aria-current', 'true');
    expect(first).not.toHaveClass('is-active');
    expect(first).not.toHaveAttribute('aria-current');
  });

  it('scroll spy switches the active anchor when a later section enters the observer band', () => {
    render(<ReportToc items={items} ariaLabel="On this page" />);
    expect(ioCallback).not.toBeNull();
    // 判定带：视口顶部 40%，顶部 -72px（与 CSS scroll-margin-top:88px 对齐，属负载契约）
    expect(ioOptions?.rootMargin).toBe('-72px 0px -60% 0px');

    act(() => {
      ioCallback!([
        entryFor('section-summary', -240, false),
        entryFor('section-authenticity', 60),
        entryFor('section-skills', 320),
      ], {} as IntersectionObserver);
    });

    const auth = screen.getByRole('link', { name: items[1].label });
    expect(auth).toHaveClass('is-active');
    expect(auth).toHaveAttribute('aria-current', 'true');
  });

  it('scroll spy picks the topmost intersecting section when several overlap the band', () => {
    render(<ReportToc items={items} ariaLabel="On this page" />);

    act(() => {
      ioCallback!([
        entryFor('section-skills', 140),
        entryFor('section-authenticity', 90),
      ], {} as IntersectionObserver);
    });

    const auth = screen.getByRole('link', { name: items[1].label });
    const skills = screen.getByRole('link', { name: items[2].label });
    expect(auth).toHaveClass('is-active');
    expect(skills).not.toHaveClass('is-active');
  });

  it('prefers the section whose top entered the band over one whose tail only grazes the band top', () => {
    // 瞬跳（reduced-motion / 程序化 scrollTo）的真实派发形态：上一章节底边还搭在
    // 带顶（top=-88，擦边相交），落点章节顶边已在带内（top=88）——必须选落点章节
    render(<ReportToc items={items} ariaLabel="On this page" />);

    act(() => {
      ioCallback!([
        entryFor('section-authenticity', -88),
        entryFor('section-skills', 88),
      ], {} as IntersectionObserver);
    });

    const auth = screen.getByRole('link', { name: items[1].label });
    const skills = screen.getByRole('link', { name: items[2].label });
    expect(skills).toHaveClass('is-active');
    expect(auth).not.toHaveClass('is-active');
  });

  it('falls back to all intersecting entries when no section top lies inside the band', () => {
    // 超高章节横跨整条判定带（top 远在带顶之上）：顶边不在带内，退回全体相交项
    render(<ReportToc items={items} ariaLabel="On this page" />);

    act(() => {
      ioCallback!([entryFor('section-authenticity', -200)], {} as IntersectionObserver);
    });

    expect(screen.getByRole('link', { name: items[1].label })).toHaveClass('is-active');
  });

  it('hides the TOC below 960px per the report-page.css media query contract', () => {
    // 隐藏逻辑是纯 CSS media query（jsdom 不应用样式表），这里以样式契约守护：
    // 断点必须与 --ja-breakpoint-lg（960px）对齐，且窄屏下 display:none
    // jsdom 环境下 import.meta.url 非 file scheme，改用 Vitest 提供的测试文件绝对路径定位
    const testFile = expect.getState().testPath!;
    const cssPath = resolve(dirname(testFile), '../styles/report-page.css');
    const css = readFileSync(cssPath, 'utf8');
    const mediaStart = css.indexOf('@media (max-width: 960px)');
    expect(mediaStart, 'report-page.css must keep the 960px breakpoint block').toBeGreaterThan(-1);
    const nextMedia = css.indexOf('@media', mediaStart + 1);
    const block = css.slice(mediaStart, nextMedia === -1 ? css.length : nextMedia);
    expect(block).toMatch(/\.report-toc\s*\{[^}]*display:\s*none/);
  });
});
