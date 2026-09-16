/**
 * ApplicationTracker——报告页求职者视角的「投递追踪」React island（痛点解决方案批次 2）。
 * GET/POST /profiles/:id/applications、PATCH /applications/:id。
 * 不做物理删除：终止/撤回用状态 withdrawn，保留完整漏斗记录。
 * 所有用户可见文案由 Astro 服务端通过 props 传入（组件不硬编码文案）。
 */
import { useEffect, useState, type FormEvent } from 'react';

type ApplicationStatus =
  | 'saved'
  | 'applied'
  | 'viewed'
  | 'interview'
  | 'offer'
  | 'rejected'
  | 'withdrawn';

interface Application {
  id: string;
  profileId: string;
  jobId: string | null;
  source: string | null;
  targetTitle: string;
  targetCompany: string;
  targetUrl: string | null;
  status: ApplicationStatus;
  note: string | null;
  origin: string;
  appliedAt: string;
  createdAt: string;
  updatedAt: string;
}

interface TrackerLabels {
  title: string;
  hint: string;
  loading: string;
  error: string;
  empty: string;
  add: string;
  company: string;
  role: string;
  url: string;
  status: string;
  note: string;
  appliedAt: string;
  companyPlaceholder: string;
  rolePlaceholder: string;
  urlPlaceholder: string;
  notePlaceholder: string;
  save: string;
  cancel: string;
  required: string;
  statusLabels: Record<ApplicationStatus, string>;
}

interface Props {
  profileId: string;
  apiBase: string;
  locale: string;
  labels: TrackerLabels;
}

const STATUS_ORDER: ApplicationStatus[] = [
  'saved',
  'applied',
  'viewed',
  'interview',
  'offer',
  'rejected',
  'withdrawn',
];

function formatDate(iso: string, locale: string): string {
  try {
    return new Date(iso).toLocaleDateString(locale === 'zh-CN' ? 'zh-CN' : 'en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return iso;
  }
}

export default function ApplicationTracker({ profileId, apiBase, locale, labels }: Props) {
  const [items, setItems] = useState<Application[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [company, setCompany] = useState('');
  const [role, setRole] = useState('');
  const [url, setUrl] = useState('');
  const [note, setNote] = useState('');
  const [appliedAt, setAppliedAt] = useState('');

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${apiBase}/profiles/${encodeURIComponent(profileId)}/applications`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { items: Application[] };
      setItems(body.items ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `${apiBase}/profiles/${encodeURIComponent(profileId)}/applications`,
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as { items: Application[] };
        if (!cancelled) setItems(body.items ?? []);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [profileId, apiBase]);

  function resetForm() {
    setCompany('');
    setRole('');
    setUrl('');
    setNote('');
    setAppliedAt('');
    setFormError(null);
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!company.trim() || !role.trim()) {
      setFormError(labels.required);
      return;
    }
    setSubmitting(true);
    setFormError(null);
    try {
      const payload: Record<string, string> = {
        targetCompany: company.trim(),
        targetTitle: role.trim(),
      };
      if (url.trim()) payload.targetUrl = url.trim();
      if (note.trim()) payload.note = note.trim();
      if (appliedAt) payload.appliedAt = new Date(`${appliedAt}T00:00:00`).toISOString();
      const res = await fetch(
        `${apiBase}/profiles/${encodeURIComponent(profileId)}/applications`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const created = (await res.json()) as Application;
      setItems((prev) => [created, ...(prev ?? [])]);
      resetForm();
      setShowForm(false);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function changeStatus(id: string, status: ApplicationStatus) {
    // 乐观更新，失败则回滚并重新加载
    const before = items;
    setItems((prev) =>
      (prev ?? []).map((a) => (a.id === id ? { ...a, status } : a)),
    );
    try {
      const res = await fetch(`${apiBase}/applications/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const updated = (await res.json()) as Application;
      setItems((prev) => (prev ?? []).map((a) => (a.id === id ? updated : a)));
    } catch {
      setItems(before);
      void load();
    }
  }

  return (
    <section className="ja-card apptrk">
      <div className="ja-flex-between apptrk-head">
        <h2>{labels.title}</h2>
        {!showForm && (
          <button type="button" className="ja-btn ja-btn--ghost" onClick={() => setShowForm(true)}>
            + {labels.add}
          </button>
        )}
      </div>
      <p className="ja-muted apptrk-hint">{labels.hint}</p>

      {loading && (
        <p className="ja-muted" role="status" aria-live="polite">
          <span className="spinner" aria-hidden="true" />
          {labels.loading}
        </p>
      )}
      {error && <p className="apptrk-error" role="alert">{labels.error}: {error}</p>}

      {!loading && !error && items && items.length === 0 && !showForm && (
        <p className="ja-muted">{labels.empty}</p>
      )}

      {showForm && (
        <form className="apptrk-form" onSubmit={handleSubmit}>
          <div className="apptrk-field">
            <label htmlFor="apptrk-company">{labels.company}</label>
            <input
              id="apptrk-company"
              className="ja-input"
              value={company}
              placeholder={labels.companyPlaceholder}
              onChange={(e) => setCompany(e.target.value)}
            />
          </div>
          <div className="apptrk-field">
            <label htmlFor="apptrk-role">{labels.role}</label>
            <input
              id="apptrk-role"
              className="ja-input"
              value={role}
              placeholder={labels.rolePlaceholder}
              onChange={(e) => setRole(e.target.value)}
            />
          </div>
          <div className="apptrk-field">
            <label htmlFor="apptrk-url">{labels.url}</label>
            <input
              id="apptrk-url"
              className="ja-input"
              type="url"
              value={url}
              placeholder={labels.urlPlaceholder}
              onChange={(e) => setUrl(e.target.value)}
            />
          </div>
          <div className="apptrk-field">
            <label htmlFor="apptrk-date">{labels.appliedAt}</label>
            <input
              id="apptrk-date"
              className="ja-input"
              type="date"
              value={appliedAt}
              onChange={(e) => setAppliedAt(e.target.value)}
            />
          </div>
          <div className="apptrk-field apptrk-field--wide">
            <label htmlFor="apptrk-note">{labels.note}</label>
            <input
              id="apptrk-note"
              className="ja-input"
              value={note}
              placeholder={labels.notePlaceholder}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
          {formError && <p className="apptrk-error apptrk-field--wide">{formError}</p>}
          <div className="apptrk-actions apptrk-field--wide">
            <button type="submit" className="ja-btn" disabled={submitting}>
              {labels.save}
            </button>
            <button
              type="button"
              className="ja-btn ja-btn--ghost"
              onClick={() => {
                resetForm();
                setShowForm(false);
              }}
            >
              {labels.cancel}
            </button>
          </div>
        </form>
      )}

      {!loading && !error && items && items.length > 0 && (
        <ul className="apptrk-list">
          {items.map((a) => (
            <li key={a.id} className="apptrk-item">
              <div className="apptrk-item-main">
                <div className="apptrk-item-title">
                  <strong>{a.targetCompany}</strong>
                  <span className="ja-muted">· {a.targetTitle}</span>
                </div>
                {a.note && <p className="ja-muted apptrk-note">{a.note}</p>}
                <div className="apptrk-item-meta">
                  <span className="ja-muted">{formatDate(a.appliedAt, locale)}</span>
                  {a.targetUrl && (
                    <a href={a.targetUrl} target="_blank" rel="noopener noreferrer">
                      {labels.url} ↗
                    </a>
                  )}
                </div>
              </div>
              <label className="apptrk-status">
                <span className="ja-muted apptrk-status-label">{labels.status}</span>
                <select
                  className="ja-input apptrk-select"
                  value={a.status}
                  onChange={(e) => changeStatus(a.id, e.target.value as ApplicationStatus)}
                  aria-label={labels.status}
                >
                  {STATUS_ORDER.map((s) => (
                    <option key={s} value={s}>
                      {labels.statusLabels[s]}
                    </option>
                  ))}
                </select>
              </label>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
