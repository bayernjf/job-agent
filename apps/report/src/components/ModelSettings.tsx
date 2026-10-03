/**
 * ModelSettings——工作台「我的模型设置」island（决策 #21，design-llm-model-provisioning §4.3）。
 *
 * BYOK 面：登录用户配置自己的 OpenAI 兼容端点（一账号一条，apiKey 服务端 AES-256-GCM
 * 加密存储）。零硬编码文案：所有字符串由 Astro 服务端经 labels 传入；样式只用
 * var(--ja-*) token 与全局工具类。
 *
 * 数据流：mount 拉 GET /account/llm-config（404=未配置、503=LLM_ENC_KEY 缺失）；
 * 保存 PUT（apiKey 留空=沿用）；测试 POST /account/llm-config/validate（最小真实请求）；
 * 清除 DELETE（confirm 后 204）。
 */
import { useCallback, useEffect, useState } from 'react';

export interface ModelSettingsLabels {
  title: string;
  subtitle: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  apiKeyHint: string;
  providerReadonly: string;
  currentKey: string;
  notConfigured: string;
  save: string;
  test: string;
  testing: string;
  saving: string;
  remove: string;
  removeConfirm: string;
  testOk: string;
  testFailed: string;
  saveSuccess: string;
  removeSuccess: string;
  saveFailed: string;
  loadFailed: string;
  noKey: string;
  encryptionMissing: string;
  byokHint: string;
}

interface ModelSettingsProps {
  apiBase: string;
  locale: 'zh-CN' | 'en';
  labels: ModelSettingsLabels;
}

interface LlmConfigGetResponse {
  configured: boolean;
  provider?: string;
  baseUrl?: string;
  model?: string;
  keyMasked?: string;
  reason?: 'encryption_missing';
}

interface LlmConfigView {
  provider: string;
  baseUrl: string;
  model: string;
  keyMasked?: string;
}

type Status =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'saving' }
  | { kind: 'testing' }
  | { kind: 'removing' }
  | { kind: 'error'; message: string };

export default function ModelSettings({ apiBase, labels }: ModelSettingsProps) {
  const [config, setConfig] = useState<LlmConfigView | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [encryptionMissing, setEncryptionMissing] = useState(false);
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    setStatus({ kind: 'loading' });
    try {
      const res = await fetch(`${apiBase}/account/llm-config`, { credentials: 'include' });
      if (!res.ok) {
        setStatus({ kind: 'error', message: labels.loadFailed });
        return;
      }
      const data = (await res.json()) as LlmConfigGetResponse;
      if (!data.configured) {
        setConfig(null);
        setEncryptionMissing(data.reason === 'encryption_missing');
        setLoaded(true);
        setStatus({ kind: 'idle' });
        return;
      }
      setConfig({
        provider: data.provider ?? 'custom',
        baseUrl: data.baseUrl ?? '',
        model: data.model ?? '',
        keyMasked: data.keyMasked,
      });
      setBaseUrl(data.baseUrl ?? '');
      setModel(data.model ?? '');
      setLoaded(true);
      setStatus({ kind: 'idle' });
    } catch {
      setStatus({ kind: 'error', message: labels.loadFailed });
    }
  }, [apiBase, labels.loadFailed]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleSave = async () => {
    if (status.kind === 'saving' || status.kind === 'testing') return;
    setMessage(null);
    setStatus({ kind: 'saving' });
    try {
      const res = await fetch(`${apiBase}/account/llm-config`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          baseUrl,
          model,
          ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        }),
      });
      if (res.status === 503) {
        setEncryptionMissing(true);
        setStatus({ kind: 'idle' });
        return;
      }
      if (!res.ok) {
        setStatus({ kind: 'error', message: labels.saveFailed });
        return;
      }
      setApiKey('');
      await load();
      setMessage(labels.saveSuccess);
    } catch {
      setStatus({ kind: 'error', message: labels.saveFailed });
    }
  };

  const handleTest = async () => {
    if (status.kind === 'saving' || status.kind === 'testing' || !config) return;
    setMessage(null);
    setStatus({ kind: 'testing' });
    try {
      const res = await fetch(`${apiBase}/account/llm-config/validate`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { reason?: string } | null;
        setStatus({ kind: 'idle' });
        setMessage(labels.testFailed.replace('{reason}', body?.reason ?? String(res.status)));
        return;
      }
      const data = (await res.json()) as { model: string };
      setStatus({ kind: 'idle' });
      setMessage(labels.testOk.replace('{model}', data.model));
    } catch {
      setStatus({ kind: 'idle' });
      setMessage(labels.testFailed.replace('{reason}', 'network'));
    }
  };

  const handleRemove = async () => {
    if (!config) return;
    if (!window.confirm(labels.removeConfirm)) return;
    setMessage(null);
    setStatus({ kind: 'removing' });
    try {
      const res = await fetch(`${apiBase}/account/llm-config`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!res.ok) {
        setStatus({ kind: 'error', message: labels.saveFailed });
        return;
      }
      setConfig(null);
      setBaseUrl('');
      setModel('');
      setApiKey('');
      setStatus({ kind: 'idle' });
      setMessage(labels.removeSuccess);
    } catch {
      setStatus({ kind: 'error', message: labels.saveFailed });
    }
  };

  return (
    <section className="model-settings ja-card" data-testid="model-settings">
      <h2>{labels.title}</h2>
      <p className="ja-muted">{labels.subtitle}</p>
      {status.kind === 'loading' && !loaded ? (
        <p className="ja-muted">{labels.testing}</p>
      ) : encryptionMissing ? (
        <p className="ja-warn" role="alert">
          {labels.encryptionMissing}
        </p>
      ) : (
        <>
          {!config ? (
            <p className="ja-muted" data-testid="model-settings-empty">
              {labels.notConfigured}
            </p>
          ) : (
            <p className="ja-muted" data-testid="model-settings-key">
              {labels.currentKey.replace('{masked}', config.keyMasked ?? '')}
            </p>
          )}
          <form
            className="model-settings-form"
            onSubmit={(e) => {
              e.preventDefault();
              void handleSave();
            }}
          >
            <label>
              {labels.baseUrl}
              <input
                type="url"
                required
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="https://api.example.com/v1"
                data-testid="model-settings-baseurl"
              />
            </label>
            <label>
              {labels.model}
              <input
                type="text"
                required
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder="my-model"
                data-testid="model-settings-model"
              />
            </label>
            <label>
              {labels.apiKey}
              <input
                type="password"
                autoComplete="off"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={labels.apiKeyHint}
                data-testid="model-settings-apikey"
              />
            </label>
            <p className="ja-muted">{labels.providerReadonly}</p>
            {status.kind === 'error' ? (
              <p className="ja-error" role="alert">
                {status.message}
              </p>
            ) : null}
            {message ? (
              <p className="ja-success" role="status">
                {message}
              </p>
            ) : null}
            <div className="ja-btn-row">
              <button
                type="submit"
                disabled={status.kind === 'saving' || status.kind === 'testing'}
                data-testid="model-settings-save"
              >
                {status.kind === 'saving' ? labels.saving : labels.save}
              </button>
              <button
                type="button"
                disabled={!config || status.kind === 'saving' || status.kind === 'testing'}
                onClick={() => void handleTest()}
                data-testid="model-settings-test"
              >
                {status.kind === 'testing' ? labels.testing : labels.test}
              </button>
              {config ? (
                <button
                  type="button"
                  className="ja-danger"
                  disabled={status.kind === 'removing'}
                  onClick={() => void handleRemove()}
                  data-testid="model-settings-remove"
                >
                  {labels.remove}
                </button>
              ) : null}
            </div>
          </form>
          <p className="ja-muted">{labels.byokHint}</p>
        </>
      )}
    </section>
  );
}
