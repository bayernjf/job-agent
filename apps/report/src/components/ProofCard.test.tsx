// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ProofCard, { drawProofCard, readProofCardColors } from './ProofCard';

const baseProps = {
  apiBase: 'https://api.job-agent.bayjf.com',
  profileId: 'prof-abc',
  login: 'octocat',
  platform: 'github',
  authLabel: 'Likely authentic',
  authClass: 'ja-badge--likely',
  confidenceLabel: '82%',
  tags: ['TypeScript', 'React', 'Node.js', 'Go', 'Rust', 'Python', 'Kubernetes'],
  verifyLine: 'Every conclusion is verifiable',
  generatedOn: 'Generated on 2026-10-30 12:00',
  domain: 'app.job-agent.bayjf.com',
  brandName: 'JobAgent',
  downloadLabel: 'Download PNG',
  downloadingLabel: 'Generating…',
  downloadFailedLabel: 'Generation failed, please retry',
};

/** jsdom 没有 2D context；给 drawProofCard 一个全 no-op 的假 ctx。 */
function stubFakeContext(): void {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ({
    fillRect: vi.fn(),
    fillText: vi.fn(),
    measureText: vi.fn(() => ({ width: 100 })),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    arcTo: vi.fn(),
    closePath: vi.fn(),
    fill: vi.fn(),
    stroke: vi.fn(),
  }) as unknown as CanvasRenderingContext2D);
}

describe('ProofCard', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(null, { status: 202 })),
    );
  });

  it('renders the proof hierarchy: login, badge, at most 6 tags, verify line', () => {
    render(<ProofCard {...baseProps} />);
    expect(screen.getByTestId('proof-card')).toBeInTheDocument();
    expect(screen.getByText('octocat')).toBeInTheDocument();
    expect(screen.getByText('Likely authentic')).toBeInTheDocument();
    expect(screen.getByText('Every conclusion is verifiable')).toBeInTheDocument();
    // 7 个传入只显示前 6 个
    expect(screen.getByText('TypeScript')).toBeInTheDocument();
    expect(screen.getByText('Python')).toBeInTheDocument();
    expect(screen.queryByText('Kubernetes')).not.toBeInTheDocument();
  });

  it('downloads a PNG named after the login and fires share_clicked', async () => {
    stubFakeContext();
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((cb) => {
      cb(new Blob(['png'], { type: 'image/png' }));
    });
    const createObjectURL = vi.fn(() => 'blob:mock');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL, revokeObjectURL }));

    render(<ProofCard {...baseProps} />);
    await userEvent.click(screen.getByRole('button', { name: 'Download PNG' }));

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect(fetch).toHaveBeenCalledWith(
      `${baseProps.apiBase}/funnel/events`,
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
        keepalive: true,
        body: JSON.stringify({ event: 'share_clicked', profileId: baseProps.profileId }),
      }),
    );
    expect(createObjectURL).toHaveBeenCalled();
  });

  it('shows the failed label and skips the funnel when 2d context is unavailable', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => null);

    render(<ProofCard {...baseProps} />);
    await userEvent.click(screen.getByRole('button', { name: 'Download PNG' }));

    expect(screen.getByRole('button', { name: 'Generation failed, please retry' })).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('shows the failed label when toBlob yields no blob', async () => {
    stubFakeContext();
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((cb) => {
      cb(null);
    });

    render(<ProofCard {...baseProps} />);
    await userEvent.click(screen.getByRole('button', { name: 'Download PNG' }));

    expect(screen.getByRole('button', { name: 'Generation failed, please retry' })).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('readProofCardColors / drawProofCard', () => {
  it('draws without throwing with runtime-read colors', () => {
    // 色值只是透传给 ctx 的 fixture：用 token 变量名当占位（tokens-guard 禁止测试文件出现颜色字面量）
    const colors = {
      bg: '--ja-color-bg',
      fg: '--ja-color-fg',
      fgMuted: '--ja-color-fg-muted',
      accent: '--ja-color-accent',
      border: '--ja-color-border',
      badgeFg: '--ja-color-auth-likely',
      badgeBg: '--ja-color-auth-likely-bg',
    };
    const data = {
      login: 'octocat',
      platform: 'github',
      authLabel: 'Likely authentic',
      confidenceLabel: '82%',
      tags: ['TypeScript', 'React'],
      verifyLine: 'Every conclusion is verifiable',
      generatedOn: 'Generated on 2026-10-30 12:00',
      domain: 'app.job-agent.bayjf.com',
      brandName: 'JobAgent',
    };
    const calls: string[] = [];
    const ctx = {
      fillRect: vi.fn(() => calls.push('fillRect')),
      fillText: vi.fn(() => calls.push('fillText')),
      measureText: vi.fn(() => ({ width: 120 })),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      arcTo: vi.fn(),
      closePath: vi.fn(),
      fill: vi.fn(),
      stroke: vi.fn(),
    } as unknown as CanvasRenderingContext2D;
    expect(() => drawProofCard(ctx, data, colors)).not.toThrow();
    expect(calls).toContain('fillRect');
    expect(calls).toContain('fillText');
  });

  it('readProofCardColors falls back to accent when badge element is missing', () => {
    // jsdom 的 getComputedStyle 不解析 CSS 变量——这里只验证「badge 缺失时走兜底分支不抛错」
    expect(() => readProofCardColors(null)).not.toThrow();
  });
});
