// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ShareButton from './ShareButton';

const props = {
  url: 'https://app.job-agent.bayjf.com/zh-CN/report/abc',
  copyLabel: 'Copy link',
  copiedLabel: 'Copied!',
  apiBase: 'https://api.job-agent.bayjf.com',
  profileId: 'prof-abc',
  shareText: "octocat's verifiable ability profile",
  systemShareLabel: 'System share…',
  xLabel: 'Share on X',
  linkedinLabel: 'Share on LinkedIn',
  redditLabel: 'Share on Reddit',
  telegramLabel: 'Share on Telegram',
  weiboLabel: 'Share on Weibo',
  wechatHint: 'WeChat: paste the link',
};

function defineNavigatorShare(impl?: () => Promise<void>): void {
  Object.defineProperty(navigator, 'share', {
    value: impl ?? vi.fn().mockResolvedValue(undefined),
    configurable: true,
    writable: true,
  });
}

async function openMenu(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getByRole('button', { name: 'Copy link' }));
  await waitFor(() =>
    expect(screen.getByTestId('share-menu-panel')).toBeInTheDocument(),
  );
}

describe('ShareButton', () => {
  beforeEach(() => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
      configurable: true,
      writable: true,
    });
    // jsdom does not implement document.execCommand (legacy fallback path)
    document.execCommand = vi.fn(() => true);
    // 漏斗埋点 fetch：fire-and-forget，测试里拦下避免真实网络
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 202 })));
  });

  afterEach(() => {
    // navigator.share 是按用例注入的能力探测，用后清理
    delete (navigator as { share?: unknown }).share;
    // window.open 的 spyOn 若不还原，下一个用例会累积上一用例的调用历史
    vi.restoreAllMocks();
  });

  it('opens the menu with aria-expanded and lists official share entries', async () => {
    const user = userEvent.setup();
    render(<ShareButton {...props} />);
    const trigger = screen.getByRole('button', { name: 'Copy link' });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');

    await user.click(trigger);

    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('menuitem', { name: 'Share on X' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Share on LinkedIn' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Share on Reddit' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Share on Telegram' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Share on Weibo' })).toBeInTheDocument();
    // 微信无 web intent：只放提示文案，不可点
    expect(screen.queryByRole('menuitem', { name: /WeChat/ })).not.toBeInTheDocument();
  });

  it('hides the system share entry when navigator.share is unavailable', async () => {
    const user = userEvent.setup();
    delete (navigator as { share?: unknown }).share;
    render(<ShareButton {...props} />);
    await openMenu(user);
    expect(screen.queryByRole('menuitem', { name: 'System share…' })).not.toBeInTheDocument();
  });

  it('copies the url from the menu and fires share_clicked', async () => {
    const user = userEvent.setup();
    render(<ShareButton {...props} />);
    await openMenu(user);
    await user.click(screen.getByRole('menuitem', { name: 'Copy link' }));

    // userEvent.setup() 接管 navigator.clipboard，无法 spy 断言写入内容——
    // 用行为反馈（Copied!）+ 漏斗上报覆盖复制路径
    await waitFor(() =>
      expect(screen.getByRole('menuitem', { name: 'Copied!' })).toBeInTheDocument(),
    );
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect(fetch).toHaveBeenCalledWith(
      `${props.apiBase}/funnel/events`,
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
        body: JSON.stringify({ event: 'share_clicked', profileId: props.profileId }),
      }),
    );
  });

  it('opens the official X intent with encoded text and url, fires share_clicked', async () => {
    const user = userEvent.setup();
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    render(<ShareButton {...props} />);
    await openMenu(user);
    await user.click(screen.getByRole('menuitem', { name: 'Share on X' }));

    expect(openSpy).toHaveBeenCalledTimes(1);
    const [href, target, features] = openSpy.mock.calls[0];
    expect(href).toBe(
      `https://twitter.com/intent/tweet?text=${encodeURIComponent(props.shareText)}&url=${encodeURIComponent(props.url)}`,
    );
    expect(target).toBe('_blank');
    expect(features).toContain('noopener');
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  });

  it('opens the LinkedIn official share entry (url only)', async () => {
    const user = userEvent.setup();
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    render(<ShareButton {...props} />);
    await openMenu(user);
    await user.click(screen.getByRole('menuitem', { name: 'Share on LinkedIn' }));

    expect(openSpy.mock.calls[0][0]).toBe(
      `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(props.url)}`,
    );
  });

  it('calls navigator.share with url and text, firing share_clicked after resolve', async () => {
    const user = userEvent.setup();
    const share = vi.fn().mockResolvedValue(undefined);
    defineNavigatorShare(share);
    render(<ShareButton {...props} />);
    await openMenu(user);
    await user.click(screen.getByRole('menuitem', { name: 'System share…' }));

    expect(share).toHaveBeenCalledWith({ title: props.shareText, text: props.shareText, url: props.url });
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  });

  it('still fires the funnel when the user cancels the system share sheet (non-abort sharing stays quiet)', async () => {
    const user = userEvent.setup();
    defineNavigatorShare(
      () => new Promise((_, reject) => reject(Object.assign(new Error('denied'), { name: 'NotAbortError' }))),
    );
    render(<ShareButton {...props} />);
    await openMenu(user);
    await user.click(screen.getByRole('menuitem', { name: 'System share…' }));

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  });

  it('does not fire the funnel when the user aborts the system share sheet', async () => {
    const user = userEvent.setup();
    defineNavigatorShare(() => new Promise((_, reject) => reject(Object.assign(new Error('abort'), { name: 'AbortError' }))));
    render(<ShareButton {...props} />);
    await openMenu(user);
    await user.click(screen.getByRole('menuitem', { name: 'System share…' }));

    await new Promise((r) => setTimeout(r, 20));
    expect(fetch).not.toHaveBeenCalled();
  });

  it('closes the menu on Escape', async () => {
    const user = userEvent.setup();
    render(<ShareButton {...props} />);
    await openMenu(user);
    await user.keyboard('{Escape}');
    await waitFor(() =>
      expect(screen.queryByTestId('share-menu-panel')).not.toBeInTheDocument(),
    );
  });
});
