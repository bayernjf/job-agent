/**
 * 填充面板（React，挂 Shadow DOM）：输入 GitHub 用户名 → 拉取可信画像 →
 * 展示可填充字段与本地补填项 → 一键写入 ATS 表单。
 *
 * 数据边界：email/教育/工作经历不在画像契约中，由用户在面板补填并仅存本机
 * localStorage（不进 JobAgent 服务端）。
 */
import { useState, type FormEvent, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ExportableProfile } from '@jobagent/shared';
import type { AtsAdapter, LocalFields } from '../ats/index.js';
import { toFillValues } from '../ats/index.js';
import { DEFAULT_BASE, JobAgentApi } from '../lib/api.js';

const API_BASE_KEY = 'jobagent.apiBase';
const LOCAL_FIELDS_KEY = 'jobagent.localFields';

export interface PanelHandle {
  toggle(): void;
}

export function mountPanel(shadow: ShadowRoot, root: Root, ats: AtsAdapter): PanelHandle {
  const mount = document.createElement('div');
  mount.id = 'jobagent-autofill-panel';
  shadow.appendChild(mount);
  root.render(<Panel ats={ats} />);
  let visible = true;
  return {
    toggle(): void {
      visible = !visible;
      mount.style.display = visible ? '' : 'none';
    },
  };
}

function loadLocal(): LocalFields {
  try {
    const raw = localStorage.getItem(LOCAL_FIELDS_KEY);
    return raw ? (JSON.parse(raw) as LocalFields) : {};
  } catch {
    return {};
  }
}

function saveLocal(fields: LocalFields): void {
  localStorage.setItem(LOCAL_FIELDS_KEY, JSON.stringify(fields));
}

function loadApiBase(): string {
  return localStorage.getItem(API_BASE_KEY) ?? DEFAULT_BASE;
}

function Panel({ ats }: { ats: AtsAdapter }): JSX.Element {
  const [username, setUsername] = useState('');
  const [apiBase, setApiBase] = useState(loadApiBase);
  const [local, setLocal] = useState<LocalFields>(loadLocal);
  const [profile, setProfile] = useState<ExportableProfile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [filled, setFilled] = useState<number | null>(null);

  async function handleAnalyze(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (!username.trim()) return;
    setError(null);
    setProfile(null);
    setLoading(true);
    localStorage.setItem(API_BASE_KEY, apiBase);
    try {
      const api = new JobAgentApi({ baseUrl: apiBase.replace(/\/$/, '') });
      const p = await api.fetchProfile(username.trim());
      setProfile(p);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  function handleFill(): void {
    if (!profile) return;
    saveLocal(local);
    const values = toFillValues(profile, local);
    const written = ats.fill(document, values);
    setFilled(written);
  }

  return (
    <div className="ja-panel">
      <div className="ja-header">
        <span>JobAgent 自动填充</span>
        <span className="ja-ats">ATS: {ats.name}</span>
      </div>

      <form onSubmit={handleAnalyze}>
        <label className="ja-label">
          GitHub 用户名
          <input
            className="ja-input"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="例如 sindresorhus"
            required
          />
        </label>
        <label className="ja-label">
          API 地址
          <input
            className="ja-input"
            value={apiBase}
            onChange={(e) => setApiBase(e.target.value)}
            placeholder="http://localhost:3000"
          />
        </label>
        <button className="ja-btn" type="submit" disabled={loading}>
          {loading ? '分析中…' : '获取可信画像'}
        </button>
      </form>

      {error && <div className="ja-error">{error}</div>}

      {profile && (
        <div className="ja-result">
          <div className="ja-row">
            <strong>{profile.subject.displayName ?? profile.subject.login}</strong>
            {profile.subject.claimed && <span className="ja-badge">本人已验证</span>}
          </div>
          <div className="ja-row">
            真实性：{profile.authenticity.status}（{(profile.authenticity.confidence * 100).toFixed(0)}%）
          </div>
          <div className="ja-row">技能：{profile.skills.map((s) => s.name).join('、') || '—'}</div>

          <details className="ja-details">
            <summary>本地补填（仅存本机，不上传）</summary>
            <label className="ja-label">
              Email
              <input
                className="ja-input"
                value={local.email ?? ''}
                onChange={(e) => setLocal((p) => ({ ...p, email: e.target.value }))}
              />
            </label>
            <label className="ja-label">
              电话
              <input
                className="ja-input"
                value={local.phone ?? ''}
                onChange={(e) => setLocal((p) => ({ ...p, phone: e.target.value }))}
              />
            </label>
            <label className="ja-label">
              所在地
              <input
                className="ja-input"
                value={local.location ?? ''}
                onChange={(e) => setLocal((p) => ({ ...p, location: e.target.value }))}
              />
            </label>
            <label className="ja-label">
              LinkedIn
              <input
                className="ja-input"
                value={local.linkedinUrl ?? ''}
                onChange={(e) => setLocal((p) => ({ ...p, linkedinUrl: e.target.value }))}
              />
            </label>
          </details>

          <button className="ja-btn ja-btn-primary" type="button" onClick={handleFill}>
            填充到表单
          </button>
          {filled !== null && (
            <div className="ja-note">已写入 {filled} 个字段；未命中的字段请手动补充。</div>
          )}
        </div>
      )}
    </div>
  );
}
