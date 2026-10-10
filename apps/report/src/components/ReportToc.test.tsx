// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import ReportToc, { type ReportTocItem } from './ReportToc';

const items: ReportTocItem[] = [
  { id: 'section-summary', label: 'Summary' },
  { id: 'section-authenticity', label: 'Authenticity' },
  { id: 'section-skills', label: 'Skill Tags' },
];

describe('ReportToc', () => {
  beforeEach(() => {
    // jsdom 无 IntersectionObserver；stub 成永不触发的观察器
    globalThis.IntersectionObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof IntersectionObserver;
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
});
