/**
 * AdminLlmCatalog——管理员「模型目录」island（决策 #21，design-llm-model-provisioning §4.2）。
 *
 * 只做**数据面**：目录行（provider/model/enabled/isDefault/sortOrder/modalities）。
 * 凭证（apiKey/baseUrl）永远在服务端 env，本面板结构上无法触及（agent-world 不变量）。
 * 保存 = 整体替换（PUT，min 1 行）；另有「刷新缓存」按钮（POST refresh）。
 *
 * 鉴权：mount 拉 /auth/me → canManageLlmCatalog=false → 403 提示；未登录 → 登录墙由
 * Astro 页处理。零硬编码文案：所有字符串由 Astro 服务端经 labels 传入。
 */
import { useCallback, useEffect, useState } from 'react';

export interface AdminLlmCatalogLabels {
  subtitle: string;
  forbidden: string;
  envConfiguredYes: string;
  envConfiguredNo: string;
  modelProvider: string;
  modelModel: string;
  modelEnabled: string;
  modelIsDefault: string;
  modelSortOrder: string;
  modelModalities: string;
  addModel: string;
  saveCatalog: string;
  refresh: string;
  refreshDone: string;
  saveSuccess: string;
  saveFailed: string;
  loadFailed: string;
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
}

interface AdminLlmCatalogView {
  models: CatalogModelRow[];
  envConfigured: boolean;
}

const DEFAULT_ROW: Omit<CatalogModelRow, 'id'> = {
  provider: 'agnes',
  model: '',
  enabled: true,
  isDefault: false,
  sortOrder: 1,
  modalities: ['text'],
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
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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
      setView(data);
      setRows(data.models);
      setEnvConfigured(data.envConfigured);
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
          models: rows.map(({ id: _id, ...rest }) => rest),
        }),
      });
      if (!res.ok) {
        if (res.status === 401) setError(labels.unauthorized);
        else if (res.status === 403) setError(labels.forbidden);
        else setError(labels.saveFailed);
        return;
      }
      const data = (await res.json()) as AdminLlmCatalogView;
      setView(data);
      setRows(data.models);
      setEnvConfigured(data.envConfigured);
      setMessage(labels.saveSuccess);
    } catch {
      setError(labels.saveFailed);
    } finally {
      setBusy(false);
    }
  };

  const handleRefresh = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch(`${apiBase}/admin/llm-catalog/refresh`, {
        method: 'POST',
        credentials: 'include',
      });
      if (!res.ok) {
        setError(labels.saveFailed);
        return;
      }
      setMessage(labels.refreshDone);
    } catch {
      setError(labels.saveFailed);
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
        <p className="ja-muted">{labels.loadFailed}</p>
      </section>
    );
  }

  return (
    <section className="admin-catalog ja-card" data-testid="admin-catalog">
      <p className="ja-muted">{labels.subtitle}</p>
      <p className={envConfigured ? 'ja-success' : 'ja-warn'} data-testid="admin-env">
        {envConfigured ? labels.envConfiguredYes : labels.envConfiguredNo}
      </p>
      <table className="admin-catalog-table">
        <thead>
          <tr>
            <th>{labels.modelProvider}</th>
            <th>{labels.modelModel}</th>
            <th>{labels.modelEnabled}</th>
            <th>{labels.modelIsDefault}</th>
            <th>{labels.modelSortOrder}</th>
            <th>{labels.modelModalities}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={row.id} data-testid="admin-model-row">
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
            </tr>
          ))}
        </tbody>
      </table>
      <p className="ja-muted">{labels.emptyHint}</p>
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
        <button
          type="button"
          disabled={busy}
          onClick={() => setRows((prev) => [...prev, { id: rowId(), ...DEFAULT_ROW }])}
          data-testid="admin-add-row"
        >
          {labels.addModel}
        </button>
        <button type="button" disabled={busy} onClick={() => void handleSave()} data-testid="admin-save">
          {labels.saveCatalog}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void handleRefresh()}
          data-testid="admin-refresh"
        >
          {labels.refresh}
        </button>
      </div>
    </section>
  );
}
