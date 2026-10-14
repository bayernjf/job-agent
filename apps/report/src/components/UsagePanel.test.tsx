// @vitest-environment jsdom
/**
 * UsagePanel island 的读侧渲染不变量（决策 #25 ④，design-cost-metering-20261014 §7 Wave D）：
 * ① 本人面 /account/usage 成功时渲染聚合表，管理员段在 /admin/usage 返回 403 时隐藏；
 * ② /admin/usage 返回 200 时展示全平台段；
 * ③ /account/usage 失败时进入 error 态。
 */
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import UsagePanel from './UsagePanel';

type Json = Record<string, unknown>;

const SAMPLE: Json = {
  summary: [
    {
      category: 'llm',
      feature: 'cover_letter',
      billingSource: 'builtin',
      events: 3,
      sumPromptTokens: 100,
      sumCompletionTokens: 50,
      sumQuantity: 0,
    },
    {
      category: 'search',
      feature: 'websearch',
      billingSource: 'platform',
      events: 1,
      sumPromptTokens: 0,
      sumCompletionTokens: 0,
      sumQuantity: 4,
    },
  ],
  daily: [
    {
      day: '2026-10-14',
      category: 'llm',
      events: 3,
      sumPromptTokens: 100,
      sumCompletionTokens: 50,
      sumQuantity: 0,
    },
  ],
};

function jsonResponse(body: Json, status = 200): Response {
  return { ok: status < 400, status, json: async () => body } as unknown as Response;
}

function stubFetch(adminResponse: Response | null) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/admin/usage')) {
      return adminResponse ?? jsonResponse({}, 403);
    }
    return jsonResponse(SAMPLE, 200);
  });
}

describe('UsagePanel', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders own summary and hides admin section when not admin', async () => {
    vi.stubGlobal('fetch', stubFetch(jsonResponse({}, 403)));
    render(<UsagePanel apiBase="" locale="en" />);

    expect(await screen.findByTestId('usage-summary')).toBeTruthy();
    expect(screen.getByText('My usage')).toBeTruthy();
    expect(screen.getByText('Cover letter')).toBeTruthy();
    // 合计行把两个 feature 的次数相加：3 + 1 = 4
    expect(screen.getByTestId('usage-total').textContent).toContain('4');

    await waitFor(() => {
      expect(screen.queryByText('All-platform usage (admin)')).toBeNull();
    });
  });

  it('shows admin section when /admin/usage returns 200', async () => {
    vi.stubGlobal('fetch', stubFetch(jsonResponse(SAMPLE, 200)));
    render(<UsagePanel apiBase="" locale="en" />);

    expect(await screen.findByText('All-platform usage (admin)')).toBeTruthy();
  });

  it('shows error state when /account/usage fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({}, 401)));
    render(<UsagePanel apiBase="" locale="zh-CN" />);

    expect(await screen.findByTestId('usage-error')).toBeTruthy();
  });
});
