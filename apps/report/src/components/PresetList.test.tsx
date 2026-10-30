// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import PresetList from './PresetList';

function makeProps() {
  return {
    locale: 'en' as const,
    apiBase: 'https://api.example',
    title: 'Explore these sample reports',
    viewLabel: 'View',
    hintLabel: 'Sample accounts are public analyses.',
    authLabels: {
      likely_authentic: 'Likely authentic',
      mixed_signals: 'Mixed signals',
      suspicious: 'Suspicious',
      insufficient_data: 'Insufficient data',
      unknown: 'Insufficient data',
    },
  };
}

const readyPreset = {
  platform: 'github' as const,
  login: 'octocat',
  authenticity: 'likely_authentic',
  profileId: 'prf-1',
  ready: true,
};

describe('PresetList', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('shows an aria-busy skeleton with the title before the fetch resolves', () => {
    // 永不 resolve：组件应稳定停留在加载骨架态
    global.fetch = vi.fn(() => new Promise<Response>(() => {}));
    render(<PresetList {...makeProps()} />);
    const loading = screen.getByTestId('preset-list-loading');
    expect(loading).toHaveAttribute('aria-busy', 'true');
    expect(
      screen.getByRole('heading', { name: 'Explore these sample reports' }),
    ).toBeInTheDocument();
  });

  it('renders only ready presets after the fetch resolves', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      json: async () => [
        readyPreset,
        {
          platform: 'github',
          login: 'notready',
          authenticity: 'unknown',
          profileId: null,
          ready: false,
        },
      ],
    });
    render(<PresetList {...makeProps()} />);
    await waitFor(() => {
      expect(screen.getByText('octocat')).toBeInTheDocument();
    });
    expect(screen.queryByText('notready')).not.toBeInTheDocument();
  });

  it('renders nothing after load when no preset is ready', async () => {
    global.fetch = vi.fn().mockResolvedValue({ json: async () => [] });
    const { container } = render(<PresetList {...makeProps()} />);
    await waitFor(() => {
      expect(container).toBeEmptyDOMElement();
    });
  });
});
