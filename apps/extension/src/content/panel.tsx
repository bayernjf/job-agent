/**
 * 填充面板（React，挂 Shadow DOM）：输入 GitHub 用户名 → 拉取可信画像 →
 * 展示可填充字段与本地补填项 → 一键写入 ATS 表单。
 *
 * 数据边界：email/教育/工作经历不在画像契约中，由用户在面板补填并仅存本机
 * localStorage（不进 JobAgent 服务端）。
 *
 * i18n（design-i18n-20260910.md 第 8 节）：所有用户可见文案走 t()；
 * 语言 = localStorage 显式选择优先，否则 navigator.languages 协商。
 */
import { useMemo, useState, type FormEvent, type JSX } from 'react';
import { createRoot } from 'react-dom/client';
import type { AuthenticityStatus, ExportableProfile } from '@jobagent/shared';
import type { AtsAdapter, LocalFields } from '../ats/index.js';
import { toFillValues } from '../ats/index.js';
import { DEFAULT_BASE, JobAgentApi } from '../lib/api.js';
import {
  LOCALE_STORAGE_KEY,
  createTranslator,
  resolveLocale,
  type Locale,
  type MessageKey,
} from '../i18n/index.js';

const API_BASE_KEY = 'jobagent.apiBase';
const LOCAL_FIELDS_KEY = 'jobagent.localFields';

/** 真实性枚举 → 展示文案 key（术语与报告页保持一致） */
const AUTH_STATUS_KEY: Record<AuthenticityStatus, MessageKey> = {
  likely_authentic: 'auth.likely_authentic',
  mixed_signals: 'auth.mixed_signals',
  suspicious: 'auth.suspicious',
  insufficient_data: 'auth.insufficient_data',
};

export interface PanelHandle {
  toggle(): void;
}

function initialLocale(): Locale {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(LOCALE_STORAGE_KEY);
  } catch {
    stored = null;
  }
  const navLanguages = typeof navigator !== 'undefined' ? Array.from(navigator.languages) : null;
  return resolveLocale(stored, navLanguages);
}

export function mountPanel(shadow: ShadowRoot, ats: AtsAdapter): PanelHandle {
  const mount = document.createElement('div');
  mount.id = 'jobagent-autofill-panel';
  shadow.appendChild(mount);
  const root = createRoot(mount);
  root.render(<Panel ats={ats} />);
  let visible = false;
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
  const [locale, setLocale] = useState<Locale>(initialLocale);
  const t = useMemo(() => createTranslator(locale), [locale]);
  const [username, setUsername] = useState('');
  const [apiBase, setApiBase] = useState(loadApiBase);
  const [local, setLocal] = useState<LocalFields>(loadLocal);
  const [profile, setProfile] = useState<ExportableProfile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [filled, setFilled] = useState<number | null>(null);

  function switchLocale(): void {
    const next: Locale = locale === 'zh-CN' ? 'en' : 'zh-CN';
    setLocale(next);
    try {
      localStorage.setItem(LOCALE_STORAGE_KEY, next);
    } catch {
      // localStorage 不可用时仅本次会话生效
    }
  }

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
    const values = toFillValues(profile, local, {
      skillsLeadin: t('fill.summarySkillsLeadin'),
      skillSeparator: t('fill.skillSeparator'),
    });
    const written = ats.fill(document, values);
    setFilled(written);
  }

  return (
    <div className="ja-panel">
      <div className="ja-header">
        <span className="ja-header-title">{t('panel.title')}</span>
        <span className="ja-header-actions">
          <span className="ja-ats">{t('panel.atsLabel', { name: ats.name })}</span>
          {/* 语言切换器自身文案是 i18n 设计允许的硬编码豁免项（这里取另一语言名） */}
          <button type="button" className="ja-lang" onClick={switchLocale}>
            {t('nav.language')}
          </button>
        </span>
      </div>

      <form onSubmit={handleAnalyze}>
        <label className="ja-label">
          {t('panel.usernameLabel')}
          <input
            className="ja-input"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder={t('panel.usernamePlaceholder')}
            required
          />
        </label>
        <label className="ja-label">
          {t('panel.apiBaseLabel')}
          <input
            className="ja-input"
            value={apiBase}
            onChange={(e) => setApiBase(e.target.value)}
            placeholder={t('panel.apiBasePlaceholder')}
          />
        </label>
        <button className="ja-btn" type="submit" disabled={loading}>
          {loading ? t('panel.analyzing') : t('panel.analyze')}
        </button>
      </form>

      {error && <div className="ja-error">{error}</div>}

      {profile && (
        <div className="ja-result">
          <div className="ja-row">
            <strong>{profile.subject.displayName ?? profile.subject.login}</strong>
            {profile.subject.claimed && <span className="ja-badge">{t('panel.claimedBadge')}</span>}
          </div>
          <div className="ja-row">
            {t('panel.authenticityValue', {
              status: t(AUTH_STATUS_KEY[profile.authenticity.status]),
              confidence: (profile.authenticity.confidence * 100).toFixed(0),
            })}
          </div>
          <div className="ja-row">
            {t('panel.skillsValue', {
              skills: profile.skills.map((s) => s.name).join(t('fill.skillSeparator')) || t('panel.skillsEmpty'),
            })}
          </div>

          <details className="ja-details">
            <summary>{t('panel.localFields')}</summary>
            <label className="ja-label">
              {t('panel.emailLabel')}
              <input
                className="ja-input"
                value={local.email ?? ''}
                onChange={(e) => setLocal((p) => ({ ...p, email: e.target.value }))}
              />
            </label>
            <label className="ja-label">
              {t('panel.phoneLabel')}
              <input
                className="ja-input"
                value={local.phone ?? ''}
                onChange={(e) => setLocal((p) => ({ ...p, phone: e.target.value }))}
              />
            </label>
            <label className="ja-label">
              {t('panel.locationLabel')}
              <input
                className="ja-input"
                value={local.location ?? ''}
                onChange={(e) => setLocal((p) => ({ ...p, location: e.target.value }))}
              />
            </label>
            <label className="ja-label">
              {t('panel.linkedinLabel')}
              <input
                className="ja-input"
                value={local.linkedinUrl ?? ''}
                onChange={(e) => setLocal((p) => ({ ...p, linkedinUrl: e.target.value }))}
              />
            </label>
          </details>

          <button className="ja-btn ja-btn-primary" type="button" onClick={handleFill}>
            {t('panel.fill')}
          </button>
          {filled !== null && (
            <div className="ja-note">{t('panel.filledNote', { count: filled })}</div>
          )}
        </div>
      )}
    </div>
  );
}
