// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
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
    timeoutLabel: 'Temporarily unavailable',
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
});
