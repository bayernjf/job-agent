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
import {
  DEFAULT_BASE,
  JobAgentApi,
  matchJobs,
  type EvidenceBrief,
  type JobMatchItem,
  type JobMatchSkillReason,
} from '../lib/api.js';
import { matchTier, resolveEvidenceLinks } from './match-utils.js';
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
  const [matchState, setMatchState] = useState<'idle' | 'loading' | 'empty' | 'error' | 'list'>('idle');
  const [matches, setMatches] = useState<JobMatchItem[]>([]);
  const [matchEvidence, setMatchEvidence] = useState<Record<string, EvidenceBrief> | undefined>(undefined);
  const [matchError, setMatchError] = useState<string | null>(null);

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
    setMatchState('idle');
    setMatches([]);
    setMatchEvidence(undefined);
    setMatchError(null);
    localStorage.setItem(API_BASE_KEY, apiBase);
    try {
      const api = new JobAgentApi({ baseUrl: apiBase.replace(/\/$/, '') });
      const p = await api.fetchProfile(username.trim());
      setProfile(p);
      // 异步触发匹配，不阻塞画像展示与一键填充
      void loadMatches(p.profileId);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function loadMatches(profileId: string): Promise<void> {
    setMatchState('loading');
    setMatchError(null);
    try {
      const resp = await matchJobs(apiBase.replace(/\/$/, ''), profileId, { limit: 5 });
      setMatches(resp.matches);
      setMatchEvidence(resp.evidence);
      setMatchState(resp.matches.length > 0 ? 'list' : 'empty');
    } catch (err) {
      setMatchError((err as Error).message);
      setMatchState('error');
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

          {matchState !== 'idle' && (
            <div className="ja-match">
              <div className="ja-match-header">
                <span className="ja-match-title">
                  {t('match.title')}
                  {matchState === 'list' && ` (${matches.length})`}
                </span>
                {(matchState === 'list' || matchState === 'empty' || matchState === 'error') && (
                  <button
                    type="button"
                    className="ja-match-refresh"
                    onClick={() => void loadMatches(profile.profileId)}
                  >
                    {t('match.refresh')}
                  </button>
                )}
              </div>

              {matchState === 'loading' && <div className="ja-match-loading">{t('match.loading')}</div>}

              {matchState === 'empty' && <div className="ja-match-empty">{t('match.empty')}</div>}

              {matchState === 'error' && (
                <div className="ja-match-error">
                  {t('match.error')}
                  {matchError && <span className="ja-match-error-detail">: {matchError}</span>}
                  <button type="button" className="ja-match-retry" onClick={() => void loadMatches(profile.profileId)}>
                    {t('match.retry')}
                  </button>
                </div>
              )}

              {matchState === 'list' && (
                <ul className="ja-match-list">
                  {matches.map((m, idx) => {
                    const tier = matchTier(m.score, m.matchedSkills);
                    const links = resolveEvidenceLinks(
                      m.skillReasons?.flatMap((r) => r.evidenceRefs) ?? [],
                      matchEvidence,
                    );
                    return (
                      <li key={`${m.posting.sourceUrl}-${idx}`} className="ja-match-item">
                        <div className="ja-match-item-head">
                          <span className={`ja-match-score ja-match-score-${tier}`}>{m.score}</span>
                          <a
                            className="ja-match-job"
                            href={m.posting.sourceUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            <span className="ja-match-title-text">{m.posting.title}</span>
                            {m.posting.company && <span className="ja-match-company">@ {m.posting.company}</span>}
                          </a>
                        </div>
                        <div className="ja-match-skills">
                          {m.matchedSkills.map((s) => (
                            <span key={s} className="ja-match-chip">
                              {s}
                            </span>
                          ))}
                        </div>
                        {(m.fieldScores || m.skillReasons || m.skillHits || links.length > 0) && (
                          <details className="ja-match-basis">
                            <summary>{t('match.basis')}</summary>
                            {m.fieldScores && (
                              <div className="ja-match-breakdown">
                                <span className="ja-match-breakdown-label">{t('match.scoreBreakdown')}:</span>
                                <span className="ja-match-breakdown-chip">title {m.fieldScores.title}</span>
                                <span className="ja-match-breakdown-chip">tags {m.fieldScores.tags}</span>
                                <span className="ja-match-breakdown-chip">desc {m.fieldScores.description}</span>
                              </div>
                            )}
                            {(m.skillReasons ?? m.skillHits) && (
                              <ul className="ja-match-skill-reasons">
                                {(m.skillReasons ?? m.skillHits ?? []).map((hit) => (
                                  <li key={hit.skill} className="ja-match-skill-reason">
                                    <strong>{hit.skill}</strong>
                                    {'depth' in hit && (
                                      <span className="ja-match-skill-depth"> · {(hit as JobMatchSkillReason).depth}</span>
                                    )}
                                    <span className="ja-match-skill-fields"> · {hit.fields.join('/')}</span>
                                    <span className="ja-match-skill-score"> · {hit.score}</span>
                                  </li>
                                ))}
                              </ul>
                            )}
                            {links.length > 0 && (
                              <div className="ja-match-evidence">
                                <span className="ja-match-evidence-label">{t('match.evidence')}:</span>
                                <ul>
                                  {links.map((l) => (
                                    <li key={l.url}>
                                      <a href={l.url} target="_blank" rel="noopener noreferrer">
                                        {l.label}
                                      </a>
                                    </li>
                                  ))}
                                </ul>
                              </div>
                            )}
                          </details>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          )}

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
