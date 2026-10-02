// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import DemoBanner from './DemoBanner';

const props = {
  apiBase: 'https://api.example',
  label: 'Demo mode',
  remainingLabel: '{remaining} analyses left',
  exitLabel: 'Exit demo',
};

const demoMe = {
  kind: 'demo',
  analyzeQuota: 3,
  analyzeUsed: 1,
  analyzeRemaining: 2,
  expiresAt: new Date(Date.now() + 3600_000).toISOString(),
};

describe('DemoBanner', () => {
  const reload = vi.fn();

  beforeEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(window, 'location', {
      value: { href: '', reload },
      writable: true,
      configurable: true,
    });
  });

  it('renders nothing for an anonymous viewer', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ kind: 'anonymous' }),
    });
    const { container } = render(<DemoBanner {...props} />);

    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the remaining quota for a demo viewer', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => demoMe });
    render(<DemoBanner {...props} />);

    expect(await screen.findByRole('status')).toBeInTheDocument();
    expect(screen.getByText('Demo mode')).toBeInTheDocument();
    expect(screen.getByText('2 analyses left')).toBeInTheDocument();
  });

  it('posts /demo/exit then reloads when the exit button is clicked', async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => demoMe })
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) });

    render(<DemoBanner {...props} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Exit demo' }));

    await waitFor(() => expect(reload).toHaveBeenCalled());
    expect(global.fetch).toHaveBeenLastCalledWith('https://api.example/demo/exit', {
      method: 'POST',
      credentials: 'include',
    });
  });
});
