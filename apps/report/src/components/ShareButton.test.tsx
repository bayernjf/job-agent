// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ShareButton from './ShareButton';

const props = {
  url: 'https://app.job-agent.bayjf.com/zh-CN/report/abc',
  copyLabel: 'Copy link',
  copiedLabel: 'Copied!',
  apiBase: 'https://api.job-agent.bayjf.com',
  profileId: 'prof-abc',
};

describe('ShareButton', () => {
  beforeEach(() => {
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
    // jsdom does not implement document.execCommand (legacy fallback path)
    document.execCommand = vi.fn(() => true);
    // 漏斗埋点 fetch：fire-and-forget，测试里拦下避免真实网络
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 202 })));
  });

  it('copies the url via the clipboard API and shows the copied feedback', async () => {
    render(<ShareButton {...props} />);
    const button = screen.getByRole('button', { name: 'Copy link' });

    await userEvent.click(button);

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(props.url);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Copied!' })).toBeInTheDocument(),
    );
  });

  it('falls back to execCommand when the clipboard API rejects', async () => {
    (navigator.clipboard.writeText as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('denied'),
    );
    render(<ShareButton {...props} />);
    await userEvent.click(screen.getByRole('button', { name: 'Copy link' }));

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Copied!' })).toBeInTheDocument(),
    );
    expect(document.execCommand).toHaveBeenCalledWith('copy');
  });

  it('fires a share_clicked funnel event after copying (fire-and-forget)', async () => {
    render(<ShareButton {...props} />);
    await userEvent.click(screen.getByRole('button', { name: 'Copy link' }));

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect(fetch).toHaveBeenCalledWith(
      `${props.apiBase}/funnel/events`,
      expect.objectContaining({
        method: 'POST',
        keepalive: true,
        body: JSON.stringify({ event: 'share_clicked', profileId: props.profileId }),
      }),
    );
  });

  it('still shows the copied feedback when the funnel event request fails', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('network down'));
    render(<ShareButton {...props} />);
    await userEvent.click(screen.getByRole('button', { name: 'Copy link' }));

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Copied!' })).toBeInTheDocument(),
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
