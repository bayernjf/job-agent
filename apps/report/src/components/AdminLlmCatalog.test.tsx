// @vitest-environment jsdom
/**
 * AdminLlmCatalog island 的加载占位与鉴权失败分支（2026-10-12）。
 *
 * 回归背景（提交 7b57119）：面板首屏曾在 fetch 尚未返回时渲染「加载目录失败」文案，
 * 而真实 API 对未登录读者返回 401——初始占位误用了 loadFailed，用户每次打开 admin 页
 * 都会先看到一句错误。这里钉死四条不变量：
 * ① 请求进行中只显示 loading 占位，绝不闪现 loadFailed / forbidden / unauthorized；
 * ② 401 → unauthorized 文案；③ 403 → forbidden 文案；④ 其他非 2xx → loadFailed；
 * ⑤ 200 → 渲染目录行与 env 配置状态。
 */
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AdminLlmCatalog, { type AdminLlmCatalogLabels } from './AdminLlmCatalog';

const labels: AdminLlmCatalogLabels = {
  subtitle: 'SUBTITLE',
  forbidden: 'FORBIDDEN',
  envConfiguredYes: 'ENV_YES',
  envConfiguredNo: 'ENV_NO',
  hubConfiguredYes: 'HUB_YES',
  modelProvider: 'Provider',
  modelModel: 'Model',
  modelEnabled: 'Enabled',
  modelIsDefault: 'Default',
  modelSortOrder: 'Sort',
  modelModalities: 'Modalities',
  modelSource: 'Source',
  modelAssignmentId: 'Assignment',
  revision: 'Revision',
  addModel: 'Add',
  saveCatalog: 'Save',
  refresh: 'Refresh',
  sync: 'Sync',
  refreshDone: 'Refreshed',
  syncDone: 'Synced',
  syncFailed: 'SYNC_FAILED',
  readOnlyHint: 'READ_ONLY',
  saveSuccess: 'Saved',
  saveFailed: 'SAVE_FAILED',
  loadFailed: 'LOAD_FAILED',
  loading: 'LOADING_PLACEHOLDER',
  unauthorized: 'UNAUTHORIZED',
  emptyHint: 'EMPTY_HINT',
};

function stubResponse(response: Partial<Response> | 'pending'): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      if (response === 'pending') return new Promise(() => {});
      return Promise.resolve({
        ok: false,
        status: 500,
        json: async () => ({}),
        ...response,
      } as Response);
    }),
  );
}

describe('AdminLlmCatalog 加载态', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('请求进行中只显示 loading 占位，不闪现任何失败文案', () => {
    stubResponse('pending');
    render(<AdminLlmCatalog apiBase="http://api.test" locale="zh-CN" labels={labels} />);

    expect(screen.getByText('LOADING_PLACEHOLDER')).toBeTruthy();
    expect(screen.queryByText('LOAD_FAILED')).toBeNull();
    expect(screen.queryByText('FORBIDDEN')).toBeNull();
    expect(screen.queryByText('UNAUTHORIZED')).toBeNull();
  });

  it('401 时显示 unauthorized', async () => {
    stubResponse({ ok: false, status: 401 });
    render(<AdminLlmCatalog apiBase="http://api.test" locale="zh-CN" labels={labels} />);
    await waitFor(() => expect(screen.getByText('UNAUTHORIZED')).toBeTruthy());
    expect(screen.queryByText('LOADING_PLACEHOLDER')).toBeNull();
  });

  it('403 时显示 forbidden', async () => {
    stubResponse({ ok: false, status: 403 });
    render(<AdminLlmCatalog apiBase="http://api.test" locale="zh-CN" labels={labels} />);
    await waitFor(() => expect(screen.getByText('FORBIDDEN')).toBeTruthy());
  });

  it('500 时显示 loadFailed', async () => {
    stubResponse({ ok: false, status: 500 });
    render(<AdminLlmCatalog apiBase="http://api.test" locale="zh-CN" labels={labels} />);
    await waitFor(() => expect(screen.getByText('LOAD_FAILED')).toBeTruthy());
  });

  it('200 本地模式渲染目录行与 env 配置状态', async () => {
    stubResponse({
      ok: true,
      status: 200,
      json: async () => ({
        envConfigured: true,
        hubConfigured: false,
        revision: null,
        models: [
          {
            id: 'm1',
            provider: 'custom',
            model: 'agnes-3.0-flash',
            enabled: true,
            isDefault: true,
            sortOrder: 1,
            modalities: ['text'],
            source: 'builtin',
            revision: null,
            assignmentId: null,
          },
        ],
      }),
    });
    render(<AdminLlmCatalog apiBase="http://api.test" locale="zh-CN" labels={labels} />);

    await waitFor(() => expect(screen.getByText('ENV_YES')).toBeTruthy());
    expect(screen.getAllByTestId('admin-model-row')).toHaveLength(1);
    expect((screen.getByTestId('admin-model-model') as HTMLInputElement).value).toBe(
      'agnes-3.0-flash',
    );
  });

  it('200 hub 模式渲染只读目录与同步状态', async () => {
    stubResponse({
      ok: true,
      status: 200,
      json: async () => ({
        envConfigured: false,
        hubConfigured: true,
        revision: 42,
        models: [
          {
            id: 'noul',
            provider: 'volces',
            model: 'ark-code-latest',
            enabled: true,
            isDefault: true,
            sortOrder: 0,
            modalities: ['text'],
            source: 'hub',
            revision: 42,
            assignmentId: 'asn_0001',
          },
        ],
      }),
    });
    render(<AdminLlmCatalog apiBase="http://api.test" locale="zh-CN" labels={labels} />);

    await waitFor(() =>
      expect(screen.getByTestId('admin-hub').textContent).toContain('HUB_YES'),
    );
    expect(screen.getByTestId('admin-model-source').textContent).toBe('hub');
    // Read-only: no add/save controls, sync button present.
    expect(screen.queryByTestId('admin-add-row')).toBeNull();
    expect(screen.queryByTestId('admin-save')).toBeNull();
    expect(screen.getByTestId('admin-refresh').textContent).toBe('Sync');
  });
});
