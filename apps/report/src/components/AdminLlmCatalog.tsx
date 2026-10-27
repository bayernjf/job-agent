/**
 * AdminLlmCatalog——管理员「模型目录」island（决策 #21，design-llm-model-provisioning §4.2；
 * W5-1 改为 model-hub 同步）。
 *
 * 两种模式：
 * - **hub 同步（hubConfigured=true）**：目录只读，凭证/目录都由 model-hub 投影下发；
 *   表格展示来源（source）、分配 ID（assignmentId）与中心修订号，「立即同步」重新拉取。
 * - **本地模式（hub 未配置，迁移期）**：保留原数据面编辑（provider/model/enabled/
 *   isDefault/sortOrder/modalities），凭证仍在服务端 env，结构上无法触及。
 *
 * 鉴权：mount 拉 /admin/llm-catalog → 401/403 提示；未登录 → 登录墙由 Astro 页处理。
 * 零硬编码文案：所有字符串由 Astro 服务端经 labels 传入。
 */
import { useCallback, useEffect, useState } from 'react';

export interface AdminLlmCatalogLabels {
  subtitle: string;
  forbidden: string;
  envConfiguredYes: string;
  envConfiguredNo: string;
  hubConfiguredYes: string;
  modelProvider: string;
  modelModel: string;
  modelEnabled: string;
  modelIsDefault: string;
  modelSortOrder: string;
  modelModalities: string;
  modelSource: string;
  modelAssignmentId: string;
  revision: string;
  addModel: string;
  saveCatalog: string;
  refresh: string;
  sync: string;
  refreshDone: string;
  syncDone: string;
  syncFailed: string;
  readOnlyHint: string;
  saveSuccess: string;
  saveFailed: string;
  loadFailed: string;
  loading: string;
  unauthorized: string;
  emptyHint: string;
}

interface AdminLlmCatalogProps {
  apiBase: string;
  locale: 'zh-CN' | 'en';
  labels: AdminLlmCatalogLabels;
}

interface CatalogModelRow {
  id: string;
  provider: string;
  model: string;
  enabled: boolean;
  isDefault: boolean;
  sortOrder: number;
  modalities: string[];
  source: 'builtin' | 'hub';
  revision: number | null;
  assignmentId: string | null;
}

interface AdminLlmCatalogView {
  models: CatalogModelRow[];
  envConfigured: boolean;
  hubConfigured: boolean;
  revision: number | null;
}

const DEFAULT_ROW: Omit<CatalogModelRow, 'id'> = {
  provider: 'agnes',
  model: '',
  enabled: true,
  isDefault: false,
  sortOrder: 1,
  modalities: ['text'],
  source: 'builtin',
  revision: null,
  assignmentId: null,
};

function rowId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `row-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export default function AdminLlmCatalog({ apiBase, labels }: AdminLlmCatalogProps) {
  const [granted, setGranted] = useState<boolean | null>(null);
  const [view, setView] = useState<AdminLlmCatalogView | null>(null);
  const [rows, setRows] = useState<CatalogModelRow[]>([]);
  const [envConfigured, setEnvConfigured] = useState(false);
  const [hubConfigured, setHubConfigured] = useState(false);
  const [revision, setRevision] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const applyView = (data: AdminLlmCatalogView) => {
    setView(data);
    setRows(data.models);
    setEnvConfigured(data.envConfigured);
    setHubConfigured(data.hubConfigured);
    setRevision(data.revision);
  };

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${apiBase}/admin/llm-catalog`, { credentials: 'include' });
      if (!res.ok) {
        if (res.status === 401) setError(labels.unauthorized);
        else if (res.status === 403) setError(labels.forbidden);
        else setError(labels.loadFailed);
        setGranted(false);
        return;
      }
      const data = (await res.json()) as AdminLlmCatalogView;
      applyView(data);
      setGranted(true);
    } catch {
      setError(labels.loadFailed);
      setGranted(false);
    } finally {
      setBusy(false);
    }
  }, [apiBase, labels]);

  useEffect(() => {
    void load();
  }, [load]);

  const updateRow = (index: number, patch: Partial<CatalogModelRow>) => {
    setRows((prev) => prev.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  };

  const handleSave = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch(`${apiBase}/admin/llm-catalog`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          models: rows.map(
            ({ id: _id, source: _s, revision: _r, assignmentId: _a, ...rest }) => rest,
          ),
        }),
      });
      if (!res.ok) {
        if (res.status === 401) setError(labels.unauthorized);
        else if (res.status === 403) setError(labels.forbidden);
        else setError(labels.saveFailed);
        return;
      }
      const data = (await res.json()) as AdminLlmCatalogView;
      applyView(data);
      setMessage(labels.saveSuccess);
    } catch {
      setError(labels.saveFailed);
    } finally {
      setBusy(false);
    }
  };

  // hub 模式：POST sync 重新拉取投影；本地模式：POST refresh 重读仓储。
  const handleSyncOrRefresh = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    const path = hubConfigured ? 'sync' : 'refresh';
    try {
      const res = await fetch(`${apiBase}/admin/llm-catalog/${path}`, {
        method: 'POST',
        credentials: 'include',
      });
      if (!res.ok) {
        setError(hubConfigured ? labels.syncFailed : labels.saveFailed);
        return;
      }
      const data = (await res.json().catch(() => null)) as AdminLlmCatalogView | null;
      if (data) applyView(data);
      setMessage(hubConfigured ? labels.syncDone : labels.refreshDone);
    } catch {
      setError(hubConfigured ? labels.syncFailed : labels.saveFailed);
    } finally {
      setBusy(false);
    }
  };

  if (granted === false) {
    return (
      <section className="admin-catalog ja-card" data-testid="admin-catalog">
        <p className="ja-warn" role="alert">
          {error}
        </p>
      </section>
    );
  }

  if (granted === null && !view) {
    return (
      <section className="admin-catalog ja-card" data-testid="admin-catalog">
        <p className="ja-muted">{labels.loading}</p>
      </section>
    );
  }

  return (
    <section className="admin-catalog ja-card" data-testid="admin-catalog">
      <p className="ja-muted">{labels.subtitle}</p>
      {hubConfigured ? (
        <p className="ja-success" data-testid="admin-hub">
          {labels.hubConfiguredYes}
          {revision !== null ? ` · ${labels.revision}: ${revision}` : ''}
        </p>
      ) : (
        <p className={envConfigured ? 'ja-success' : 'ja-warn'} data-testid="admin-env">
          {envConfigured ? labels.envConfiguredYes : labels.envConfiguredNo}
        </p>
      )}
      <table className="admin-catalog-table">
        <thead>
          <tr>
            <th>{labels.modelProvider}</th>
            <th>{labels.modelModel}</th>
            <th>{labels.modelEnabled}</th>
            <th>{labels.modelIsDefault}</th>
            <th>{labels.modelSortOrder}</th>
            <th>{labels.modelModalities}</th>
            {hubConfigured ? (
              <>
                <th>{labels.modelSource}</th>
                <th>{labels.modelAssignmentId}</th>
              </>
            ) : null}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={row.id} data-testid="admin-model-row">
              {hubConfigured ? (
                <>
                  <td>{row.provider}</td>
                  <td>{row.model}</td>
                  <td>
                    <span aria-label={labels.modelEnabled}>{row.enabled ? '✓' : '✗'}</span>
                  </td>
                  <td>
                    <span aria-label={labels.modelIsDefault}>{row.isDefault ? '✓' : '✗'}</span>
                  </td>
                  <td>{row.sortOrder}</td>
                  <td>{row.modalities.join(',')}</td>
                  <td data-testid="admin-model-source">{row.source}</td>
                  <td>{row.assignmentId ?? '—'}</td>
                </>
              ) : (
                <>
                  <td>
                    <input
                      value={row.provider}
                      onChange={(e) => updateRow(i, { provider: e.target.value })}
                      data-testid="admin-model-provider"
                    />
                  </td>
                  <td>
                    <input
                      value={row.model}
                      onChange={(e) => updateRow(i, { model: e.target.value })}
                      data-testid="admin-model-model"
                    />
                  </td>
                  <td>
                    <input
                      type="checkbox"
                      checked={row.enabled}
                      onChange={(e) => updateRow(i, { enabled: e.target.checked })}
                      aria-label={labels.modelEnabled}
                    />
                  </td>
                  <td>
                    <input
                      type="checkbox"
                      checked={row.isDefault}
                      onChange={(e) => updateRow(i, { isDefault: e.target.checked })}
                      aria-label={labels.modelIsDefault}
                    />
                  </td>
                  <td>
                    <input
                      type="number"
                      min={0}
                      value={row.sortOrder}
                      onChange={(e) => updateRow(i, { sortOrder: Number(e.target.value) })}
                      aria-label={labels.modelSortOrder}
                    />
                  </td>
                  <td>
                    <input
                      value={row.modalities.join(',')}
                      onChange={(e) =>
                        updateRow(i, {
                          modalities: e.target.value
                            .split(',')
                            .map((s) => s.trim())
                            .filter(Boolean),
                        })
                      }
                      aria-label={labels.modelModalities}
                    />
                  </td>
                </>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="ja-muted">{hubConfigured ? labels.readOnlyHint : labels.emptyHint}</p>
      {error ? (
        <p className="ja-error" role="alert">
          {error}
        </p>
      ) : null}
      {message ? (
        <p className="ja-success" role="status">
          {message}
        </p>
      ) : null}
      <div className="ja-btn-row">
        {hubConfigured ? null : (
          <>
            <button
              type="button"
              disabled={busy}
              onClick={() => setRows((prev) => [...prev, { id: rowId(), ...DEFAULT_ROW }])}
              data-testid="admin-add-row"
            >
              {labels.addModel}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void handleSave()}
              data-testid="admin-save"
            >
              {labels.saveCatalog}
            </button>
          </>
        )}
        <button
          type="button"
          disabled={busy}
          onClick={() => void handleSyncOrRefresh()}
          data-testid="admin-refresh"
        >
          {hubConfigured ? labels.sync : labels.refresh}
        </button>
      </div>
    </section>
  );
}
