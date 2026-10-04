// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AnalyzeForm from './AnalyzeForm';

function makeProps() {
  return {
    locale: 'zh-CN',
    apiBase: 'https://api.example',
    placeholder: 'GitHub username',
    analyzeLabel: 'Analyze',
    analyzingLabel: 'Analyzing…',
    invalidLabel: 'Invalid username',
    queuedLabel: 'Queued',
    runningLabel: 'Running',
    failedLabel: 'Analysis failed',
    queueNoticeTitle: 'Still queued, not dropped',
    queueNoticeBody: 'The queue is drained by a scheduled poll.',
    queueJobRefLabel: 'Job ID {jobId}',
    keepWaitingLabel: 'Keep waiting',
    stageL0Label: 'L0',
    stageL1Label: 'L1',
    pollingLabel: 'Polling',
    retryLabel: 'Retry',
    attemptsLabel: 'attempt {current}/{max}',
    platformGithubLabel: 'GitHub',
    platformGiteeLabel: 'Gitee',
    platformAllLabel: 'All',
    startingDemoLabel: 'Starting demo…',
    quotaExceededLabel: 'Quota used up, resets at {resetAt}',
    rateLimitedLabel: 'Too many requests',
  };
}

const okJson = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

describe('AnalyzeForm', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    global.fetch = vi.fn();
    Object.defineProperty(window, 'location', {
      value: { href: '' },
      writable: true,
      configurable: true,
    });
  });

  it('keeps the submit button disabled while the input is empty', () => {
    render(<AnalyzeForm {...makeProps()} />);
    expect(screen.getByRole('button', { name: 'Analyze' })).toBeDisabled();
  });

  it('reports an invalid username without calling the API', async () => {
    render(<AnalyzeForm {...makeProps()} />);
    await userEvent.type(screen.getByLabelText('username'), '!!!');
    await userEvent.click(screen.getByRole('button', { name: 'Analyze' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid username');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('jumps straight to the report when a cached profile is returned', async () => {
    global.fetch = vi.fn().mockResolvedValue(okJson({ profileId: 'prof-cached' }));
    render(<AnalyzeForm {...makeProps()} />);

    await userEvent.type(screen.getByLabelText('username'), 'alice');
    await userEvent.click(screen.getByRole('button', { name: 'Analyze' }));

    await waitFor(() =>
      expect(window.location.href).toBe('/zh-CN/report/prof-cached'),
    );
  });

  it('polls the job and navigates once it succeeds', async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(okJson({ jobId: 'job-1' }))
      .mockResolvedValueOnce(okJson({ status: 'succeeded', profileId: 'prof-new' }));

    render(<AnalyzeForm {...makeProps()} />);
    await userEvent.type(screen.getByLabelText('username'), 'alice');
    await userEvent.click(screen.getByRole('button', { name: 'Analyze' }));

    // first poll happens after the 2s POLL_INTERVAL
    await waitFor(
      () => expect(window.location.href).toBe('/zh-CN/report/prof-new'),
      { timeout: 5000 },
    );
  });

  it('shows the failure message when the job fails', async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(okJson({ jobId: 'job-1' }))
      .mockResolvedValueOnce(okJson({ status: 'failed', errorMessage: 'boom' }));

    render(<AnalyzeForm {...makeProps()} />);
    await userEvent.type(screen.getByLabelText('username'), 'alice');
    await userEvent.click(screen.getByRole('button', { name: 'Analyze' }));

    await waitFor(
      () => expect(screen.getByRole('alert')).toHaveTextContent('boom'),
      { timeout: 5000 },
    );
  });

  it('auto-starts a demo session after DEMO_REQUIRED then retries the analysis', async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 403, json: async () => ({ code: 'DEMO_REQUIRED' }) })
      .mockResolvedValueOnce(okJson({})) // POST /demo/sessions
      .mockResolvedValueOnce(okJson({ profileId: 'prof-demo' })); // retried /analyze

    render(<AnalyzeForm {...makeProps()} />);
    await userEvent.type(screen.getByLabelText('username'), 'alice');
    await userEvent.click(screen.getByRole('button', { name: 'Analyze' }));

    await waitFor(() =>
      expect(window.location.href).toBe('/zh-CN/report/prof-demo'),
    );
    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.example/demo/sessions',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('shows the quota message when the demo quota is exhausted', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      json: async () => ({ code: 'DEMO_QUOTA_EXCEEDED', resetAt: new Date().toISOString() }),
    });

    render(<AnalyzeForm {...makeProps()} />);
    await userEvent.type(screen.getByLabelText('username'), 'alice');
    await userEvent.click(screen.getByRole('button', { name: 'Analyze' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Quota used up');
  });

  it('turns an exhausted poll budget into a queue notice, not an error', async () => {
    vi.useFakeTimers();
    try {
      global.fetch = vi
        .fn()
        .mockResolvedValueOnce(okJson({ jobId: 'job-queue-1', status: 'queued' }))
        .mockResolvedValue(okJson({ status: 'queued', stage: null, profileId: null }));

      render(<AnalyzeForm {...makeProps()} />);
      fireEvent.change(screen.getByLabelText('username'), { target: { value: 'alice' } });
      fireEvent.click(screen.getByRole('button', { name: 'Analyze' }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 2_000);
      });

      const notice = screen.getByTestId('queue-notice');
      expect(notice).toHaveTextContent('Still queued, not dropped');
      expect(notice).toHaveTextContent('Job ID job-queue-1');
      expect(screen.queryByRole('alert')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps waiting on the same job and navigates when it finally lands', async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(okJson({ jobId: 'job-queue-2', status: 'queued' }))
        .mockResolvedValue(okJson({ status: 'queued', stage: null, profileId: null }));
      global.fetch = fetchMock;

      render(<AnalyzeForm {...makeProps()} />);
      fireEvent.change(screen.getByLabelText('username'), { target: { value: 'alice' } });
      fireEvent.click(screen.getByRole('button', { name: 'Analyze' }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 2_000);
      });
      expect(screen.getByTestId('queue-notice')).toBeInTheDocument();

      // 消费通道随后把这份报告交付了：继续等待复用同一个任务，不重新提交
      fetchMock.mockResolvedValue(
        okJson({ status: 'succeeded', profileId: 'prof-late', stage: 'complete' }),
      );
      fireEvent.click(screen.getByRole('button', { name: 'Keep waiting' }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_000);
      });

      expect(window.location.href).toBe('/zh-CN/report/prof-late');
    } finally {
      vi.useRealTimers();
    }
  });
});
