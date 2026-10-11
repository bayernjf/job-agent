// @vitest-environment jsdom
/**
 * ModelSettings island 的「测试连接」请求形状（决策 #21，BYOK 面）。
 *
 * 2026-10-10 生产实测：这个按钮**点下去永远 400**——UI 发 `body: {}`，而服务端当时要求
 * body 必带 apiKey（保存后密钥框是空的，用户根本给不出）。修法是服务端回落到已保存配置，
 * 所以这里钉的是 UI 侧的两条不变量：
 * ① 没改端点时不发送任何凭据（空体＝"测我保存的那一组"）；
 * ② 改了端点却没填 key 时**一个请求都不发**——不能让用户以为在测新地址，
 *    实际上却拿旧 key 打过去。
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ModelSettings, { type ModelSettingsLabels } from './ModelSettings';

const labels: ModelSettingsLabels = {
  title: '我的模型设置',
  subtitle: '自带一个 OpenAI 兼容端点',
  baseUrl: 'API Base URL',
  model: '模型',
  apiKey: 'API Key',
  apiKeyHint: '留空则不改',
  providerReadonly: 'provider 固定 custom',
  currentKey: '当前密钥 {masked}',
  notConfigured: '还没配置',
  save: '保存',
  test: '测试连接',
  testing: '测试中',
  saving: '保存中',
  remove: '清除',
  removeConfirm: '确定？',
  testOk: '连接成功：{model}',
  testFailed: '连接失败：{reason}',
  testNeedsKey: '端点或模型改过了：请先保存，或再填一次 API Key。',
  saveSuccess: '已保存',
  removeSuccess: '已清除',
  saveFailed: '保存失败',
  loadFailed: '读取失败',
  noKey: '未登录',
  encryptionMissing: '服务端缺加密密钥',
  byokHint: '密钥只在服务端加密存储',
};

const SAVED = {
  configured: true,
  provider: 'custom',
  baseUrl: 'https://saved.test/v1',
  model: 'saved-model',
  keyMasked: 'sk-****1234',
};

/** 记录每次 fetch 的 {method,url,body}，按 url 分支回包。 */
function stubFetch(getResponse: Record<string, unknown> = SAVED) {
  const calls: Array<{ method: string; url: string; body: string | null }> = [];
  vi.stubGlobal(
    'fetch',
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ method: init?.method ?? 'GET', url, body: (init?.body as string) ?? null });
      if (url.endsWith('/account/llm-config/validate')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, provider: 'custom', model: 'saved-model' }),
        } as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => (url.endsWith('/account/llm-config') ? getResponse : {}),
      } as Response;
    },
  );
  return calls;
}

describe('ModelSettings 测试连接', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('已保存配置下点测试：发空体，让服务端用它保存的那一组', async () => {
    const calls = stubFetch();
    render(<ModelSettings apiBase="https://api.test" locale="zh-CN" labels={labels} />);

    await waitFor(() => expect(screen.getByTestId('model-settings-key')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('model-settings-test'));

    await waitFor(() =>
      expect(calls.some((c) => c.url.endsWith('/validate'))).toBe(true),
    );
    const call = calls.find((c) => c.url.endsWith('/validate'))!;
    // 密钥框保存后是空的，所以这里必须**不带任何凭据**——曾经它带 {} 而服务端要 key，
    // 于是该按钮恒 400
    expect(call.body).toBe('{}');
    expect(screen.getByRole('status')).toHaveTextContent('连接成功：saved-model');
  });

  it('改了端点但没填 key：一个请求都不发，并解释为什么', async () => {
    const calls = stubFetch();
    render(<ModelSettings apiBase="https://api.test" locale="zh-CN" labels={labels} />);

    await waitFor(() => expect(screen.getByTestId('model-settings-key')).toBeInTheDocument());
    fireEvent.change(screen.getByTestId('model-settings-baseurl'), {
      target: { value: 'https://evil.test/v1' },
    });
    fireEvent.click(screen.getByTestId('model-settings-test'));

    expect(calls.some((c) => c.url.endsWith('/validate'))).toBe(false);
    expect(screen.getByRole('status')).toHaveTextContent('端点或模型改过了');
  });

  it('填了 key：把表单这一组原样发给服务端', async () => {
    const calls = stubFetch();
    render(<ModelSettings apiBase="https://api.test" locale="zh-CN" labels={labels} />);

    await waitFor(() => expect(screen.getByTestId('model-settings-key')).toBeInTheDocument());
    fireEvent.change(screen.getByTestId('model-settings-apikey'), { target: { value: 'sk-new-9' } });
    fireEvent.click(screen.getByTestId('model-settings-test'));

    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/validate'))).toBe(true));
    const call = calls.find((c) => c.url.endsWith('/validate'))!;
    expect(JSON.parse(call.body ?? '{}')).toEqual({
      baseUrl: 'https://saved.test/v1',
      model: 'saved-model',
      apiKey: 'sk-new-9',
    });
  });

  it('失败时显示服务端给的 error 原文，而不是只剩状态码', async () => {
    const calls: Array<{ url: string; body: string | null }> = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, body: (init?.body as string) ?? null });
      if (url.endsWith('/validate')) {
        return {
          ok: false,
          status: 400,
          json: async () => ({ error: 'testing an unsaved baseUrl/model requires its apiKey' }),
        } as Response;
      }
      return { ok: true, status: 200, json: async () => SAVED } as Response;
    });
    render(<ModelSettings apiBase="https://api.test" locale="zh-CN" labels={labels} />);

    await waitFor(() => expect(screen.getByTestId('model-settings-key')).toBeInTheDocument());
    fireEvent.change(screen.getByTestId('model-settings-apikey'), { target: { value: 'sk-x' } });
    fireEvent.click(screen.getByTestId('model-settings-test'));

    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(
        'testing an unsaved baseUrl/model requires its apiKey',
      ),
    );
  });
});
