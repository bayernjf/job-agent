/**
 * InterviewPlanner——报告页 /recruit 招聘方视角的「面试计划」React island（handoff item45）。
 * POST/GET /interviews、PATCH /interviews/:id；全部端点要求登录、按账号行级隔离。
 * 挂载先 GET /auth/me：非登录用户渲染登录墙；登录后并行加载候选人（GET /candidates）
 * 与本人面试（GET /interviews）。不做物理删除：取消/爽约走 status=cancelled/no_show。
 * 所有用户可见文案由 Astro 服务端通过 props 传入（组件不硬编码文案）。
 */
import { useEffect, useState, type FormEvent } from 'react';

type InterviewFormat = 'onsite' | 'phone' | 'video';
type InterviewStatus =
  | 'scheduled'
  | 'completed'
  | 'cancelled'
  | 'no_show'
  | 'rescheduled';
type InterviewOutcome = 'strong_yes' | 'yes' | 'neutral' | 'no';

interface Interview {
  id: string;
  profileId: string;
  applicationId: string | null;
  targetTitle: string;
  targetCompany: string | null;
  scheduledStart: string;
  scheduledEnd: string;
  format: InterviewFormat;
  roundLabel: string;
  interviewerName: string | null;
  interviewerEmail: string | null;
  status: InterviewStatus;
  outcome: InterviewOutcome | null;
  feedbackNote: string | null;
  rating: number | null;
  createdAt: string;
  updatedAt: string;
}

interface Candidate {
  profileId: string;
  platform: string;
  login: string;
  displayName?: string;
}

interface AuthMe {
  kind: 'anonymous' | 'demo' | 'user';
}

interface PlannerLabels {
  title: string;
  hint: string;
  loading: string;
  error: string;
  empty: string;
  add: string;
  save: string;
  cancel: string;
  required: string;
  loginRequiredTitle: string;
  loginRequiredBody: string;
  loginButton: string;
  candidate: string;
  candidatePlaceholder: string;
  role: string;
  rolePlaceholder: string;
  company: string;
  companyPlaceholder: string;
  start: string;
  end: string;
  format: string;
  round: string;
  roundPlaceholder: string;
  interviewer: string;
  interviewerPlaceholder: string;
  interviewerEmail: string;
  interviewerEmailPlaceholder: string;
  status: string;
  outcome: string;
  outcomeUnset: string;
  rating: string;
  ratingUnset: string;
  feedback: string;
  feedbackPlaceholder: string;
  saveResult: string;
  statusLabels: Record<InterviewStatus, string>;
  formatLabels: Record<InterviewFormat, string>;
  outcomeLabels: Record<InterviewOutcome, string>;
}

interface Props {
  apiBase: string;
  locale: string;
  loginHref: string;
  labels: PlannerLabels;
}

const STATUS_ORDER: InterviewStatus[] = [
  'scheduled',
  'completed',
  'rescheduled',
  'no_show',
  'cancelled',
];
const FORMAT_ORDER: InterviewFormat[] = ['onsite', 'phone', 'video'];
const OUTCOME_ORDER: InterviewOutcome[] = ['strong_yes', 'yes', 'neutral', 'no'];

function formatDateTime(iso: string, locale: string): string {
  try {
    return new Date(iso).toLocaleString(locale === 'zh-CN' ? 'zh-CN' : 'en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

/** datetime-local 输入值（本地时区，无时区后缀）转 UTC ISO8601。 */
function localInputToIso(value: string): string {
  return new Date(value).toISOString();
}

export default function InterviewPlanner({ apiBase, locale, loginHref, labels }: Props) {
  const [me, setMe] = useState<AuthMe | null>(null);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [items, setItems] = useState<Interview[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // 表单字段
  const [profileId, setProfileId] = useState('');
  const [role, setRole] = useState('');
  const [company, setCompany] = useState('');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [format, setFormat] = useState<InterviewFormat>('video');
  const [round, setRound] = useState('');
  const [interviewer, setInterviewer] = useState('');
  const [interviewerEmail, setInterviewerEmail] = useState('');

  // 每条已完成面试的结果编辑草稿：id -> 字段
  const [resultDrafts, setResultDrafts] = useState<Record<string, {
    outcome: string;
    rating: string;
    feedback: string;
  }>>({});

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [candRes, intRes] = await Promise.all([
        fetch(`${apiBase}/candidates?limit=100`, { credentials: 'include' }),
        fetch(`${apiBase}/interviews`, { credentials: 'include' }),
      ]);
      if (!candRes.ok) throw new Error(`candidates HTTP ${candRes.status}`);
      if (!intRes.ok) throw new Error(`interviews HTTP ${intRes.status}`);
      const candBody = (await candRes.json()) as { items: Candidate[] };
      const intBody = (await intRes.json()) as { items: Interview[] };
      setCandidates(candBody.items ?? []);
      setItems(intBody.items ?? []);
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
        const res = await fetch(`${apiBase}/auth/me`, { credentials: 'include' });
        if (!res.ok) throw new Error(`auth/me ${res.status}`);
        const auth = (await res.json()) as AuthMe;
        if (cancelled) return;
        setMe(auth);
        if (auth.kind === 'user') await load();
        else setLoading(false);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiBase]);

  const candidateMap = new Map(candidates.map((c) => [c.profileId, c]));
  function candidateLabel(pid: string): string {
    const c = candidateMap.get(pid);
    if (c) return `@${c.login} · ${c.platform}`;
    return pid.length > 12 ? `${pid.slice(0, 10)}…` : pid;
  }

  function resetForm() {
    setProfileId('');
    setRole('');
    setCompany('');
    setStart('');
    setEnd('');
    setFormat('video');
    setRound('');
    setInterviewer('');
    setInterviewerEmail('');
    setFormError(null);
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!profileId || !role.trim() || !start || !end || !round.trim()) {
      setFormError(labels.required);
      return;
    }
    if (new Date(end) <= new Date(start)) {
      setFormError(labels.required);
      return;
    }
    setSubmitting(true);
    setFormError(null);
    try {
      const payload: Record<string, string> = {
        profileId,
        targetTitle: role.trim(),
        scheduledStart: localInputToIso(start),
        scheduledEnd: localInputToIso(end),
        format,
        roundLabel: round.trim(),
      };
      if (company.trim()) payload.targetCompany = company.trim();
      if (interviewer.trim()) payload.interviewerName = interviewer.trim();
      if (interviewerEmail.trim()) payload.interviewerEmail = interviewerEmail.trim();
      const res = await fetch(`${apiBase}/interviews`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        credentials: 'include',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const created = (await res.json()) as Interview;
      setItems((prev) => [created, ...(prev ?? [])]);
      resetForm();
      setShowForm(false);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function patchInterview(id: string, patch: Record<string, unknown>) {
    const before = items;
    // 乐观更新
    setItems((prev) =>
      (prev ?? []).map((it) =>
        it.id === id ? ({ ...it, ...patch } as Interview) : it,
      ),
    );
    try {
      const res = await fetch(`${apiBase}/interviews/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
        credentials: 'include',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const updated = (await res.json()) as Interview;
      setItems((prev) => (prev ?? []).map((it) => (it.id === id ? updated : it)));
    } catch {
      setItems(before);
      void load();
    }
  }

  function changeStatus(it: Interview, status: InterviewStatus) {
    void patchInterview(it.id, { status });
  }

  function ensureDraft(it: Interview) {
    if (!resultDrafts[it.id]) {
      setResultDrafts((prev) => ({
        ...prev,
        [it.id]: {
          outcome: it.outcome ?? '',
          rating: it.rating ? String(it.rating) : '',
          feedback: it.feedbackNote ?? '',
        },
      }));
    }
  }

  async function saveResult(it: Interview) {
    const draft = resultDrafts[it.id];
    if (!draft) return;
    const patch: Record<string, unknown> = { status: 'completed' };
    patch.outcome = draft.outcome || null;
    patch.rating = draft.rating ? Number(draft.rating) : null;
    patch.feedbackNote = draft.feedback.trim() ? draft.feedback.trim() : null;
    await patchInterview(it.id, patch);
  }

  // 首次加载 / 未确定身份
  if (me === null || (loading && items === null)) {
    return (
      <section className="ja-card ivp">
        <h2>{labels.title}</h2>
        <p className="ja-muted" role="status" aria-live="polite">
          <span className="spinner" aria-hidden="true" />
          {labels.loading}
        </p>
      </section>
    );
  }

  // 登录墙
  if (me.kind !== 'user') {
    return (
      <section className="ja-card ivp" data-testid="interview-login-gate">
        <h2>{labels.loginRequiredTitle}</h2>
        <p className="ja-muted">{labels.loginRequiredBody}</p>
        <a className="ja-btn" href={loginHref} data-testid="interview-login-button">
          {labels.loginButton}
        </a>
      </section>
    );
  }

  return (
    <section className="ja-card ivp">
      <div className="ja-flex-between ivp-head">
        <h2>{labels.title}</h2>
        {!showForm && (
          <button type="button" className="ja-btn ja-btn--ghost" onClick={() => setShowForm(true)}>
            + {labels.add}
          </button>
        )}
      </div>
      <p className="ja-muted ivp-hint">{labels.hint}</p>

      {error && <p className="ivp-error" role="alert">{labels.error}: {error}</p>}

      {showForm && (
        <form className="ivp-form" onSubmit={handleSubmit}>
          <div className="ivp-field ivp-field--wide">
            <label htmlFor="ivp-candidate">{labels.candidate}</label>
            <select
              id="ivp-candidate"
              className="ja-input"
              value={profileId}
              onChange={(e) => setProfileId(e.target.value)}
            >
              <option value="">{labels.candidatePlaceholder}</option>
              {candidates.map((c) => (
                <option key={c.profileId} value={c.profileId}>
                  @{c.login} · {c.platform}
                </option>
              ))}
            </select>
          </div>
          <div className="ivp-field">
            <label htmlFor="ivp-role">{labels.role}</label>
            <input
              id="ivp-role"
              className="ja-input"
              value={role}
              placeholder={labels.rolePlaceholder}
              onChange={(e) => setRole(e.target.value)}
            />
          </div>
          <div className="ivp-field">
            <label htmlFor="ivp-company">{labels.company}</label>
            <input
              id="ivp-company"
              className="ja-input"
              value={company}
              placeholder={labels.companyPlaceholder}
              onChange={(e) => setCompany(e.target.value)}
            />
          </div>
          <div className="ivp-field">
            <label htmlFor="ivp-start">{labels.start}</label>
            <input
              id="ivp-start"
              className="ja-input"
              type="datetime-local"
              value={start}
              onChange={(e) => setStart(e.target.value)}
            />
          </div>
          <div className="ivp-field">
            <label htmlFor="ivp-end">{labels.end}</label>
            <input
              id="ivp-end"
              className="ja-input"
              type="datetime-local"
              value={end}
              onChange={(e) => setEnd(e.target.value)}
            />
          </div>
          <div className="ivp-field">
            <label htmlFor="ivp-format">{labels.format}</label>
            <select
              id="ivp-format"
              className="ja-input"
              value={format}
              onChange={(e) => setFormat(e.target.value as InterviewFormat)}
            >
              {FORMAT_ORDER.map((f) => (
                <option key={f} value={f}>{labels.formatLabels[f]}</option>
              ))}
            </select>
          </div>
          <div className="ivp-field">
            <label htmlFor="ivp-round">{labels.round}</label>
            <input
              id="ivp-round"
              className="ja-input"
              value={round}
              placeholder={labels.roundPlaceholder}
              onChange={(e) => setRound(e.target.value)}
            />
          </div>
          <div className="ivp-field">
            <label htmlFor="ivp-interviewer">{labels.interviewer}</label>
            <input
              id="ivp-interviewer"
              className="ja-input"
              value={interviewer}
              placeholder={labels.interviewerPlaceholder}
              onChange={(e) => setInterviewer(e.target.value)}
            />
          </div>
          <div className="ivp-field">
            <label htmlFor="ivp-interviewer-email">{labels.interviewerEmail}</label>
            <input
              id="ivp-interviewer-email"
              className="ja-input"
              type="email"
              value={interviewerEmail}
              placeholder={labels.interviewerEmailPlaceholder}
              onChange={(e) => setInterviewerEmail(e.target.value)}
            />
          </div>
          {formError && <p className="ivp-error ivp-field--wide">{formError}</p>}
          <div className="ivp-actions ivp-field--wide">
            <button type="submit" className="ja-btn" disabled={submitting}>{labels.save}</button>
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

      {!loading && !error && items && items.length === 0 && !showForm && (
        <p className="ja-muted">{labels.empty}</p>
      )}

      {!loading && items && items.length > 0 && (
        <ul className="ivp-list" data-testid="interview-list">
          {items.map((it) => {
            ensureDraft(it);
            const draft = resultDrafts[it.id] ?? {
              outcome: it.outcome ?? '',
              rating: it.rating ? String(it.rating) : '',
              feedback: it.feedbackNote ?? '',
            };
            return (
              <li key={it.id} className="ivp-item" data-testid="interview-item">
                <div className="ivp-item-main">
                  <div className="ivp-item-title">
                    <strong>{candidateLabel(it.profileId)}</strong>
                    <span className="ja-muted">· {it.targetTitle}</span>
                    {it.targetCompany && <span className="ja-muted">· {it.targetCompany}</span>}
                  </div>
                  <div className="ivp-item-meta ja-muted">
                    <span>{formatDateTime(it.scheduledStart, locale)} – {formatDateTime(it.scheduledEnd, locale)}</span>
                    <span>{labels.formatLabels[it.format]}</span>
                    <span>{it.roundLabel}</span>
                    {it.interviewerName && (
                      <span>
                        {it.interviewerName}
                        {it.interviewerEmail ? ` <${it.interviewerEmail}>` : ''}
                      </span>
                    )}
                  </div>
                  {it.status === 'completed' && (
                    <div className="ivp-result" data-testid="interview-result">
                      <label className="ivp-result-field">
                        <span className="ja-muted">{labels.outcome}</span>
                        <select
                          className="ja-input"
                          value={draft.outcome}
                          onChange={(e) =>
                            setResultDrafts((p) => ({
                              ...p,
                              [it.id]: { ...draft, outcome: e.target.value },
                            }))
                          }
                        >
                          <option value="">{labels.outcomeUnset}</option>
                          {OUTCOME_ORDER.map((o) => (
                            <option key={o} value={o}>{labels.outcomeLabels[o]}</option>
                          ))}
                        </select>
                      </label>
                      <label className="ivp-result-field">
                        <span className="ja-muted">{labels.rating}</span>
                        <select
                          className="ja-input"
                          value={draft.rating}
                          onChange={(e) =>
                            setResultDrafts((p) => ({
                              ...p,
                              [it.id]: { ...draft, rating: e.target.value },
                            }))
                          }
                        >
                          <option value="">{labels.ratingUnset}</option>
                          {[5, 4, 3, 2, 1].map((n) => (
                            <option key={n} value={String(n)}>{n}</option>
                          ))}
                        </select>
                      </label>
                      <textarea
                        className="ja-input ivp-feedback"
                        rows={2}
                        placeholder={labels.feedbackPlaceholder}
                        value={draft.feedback}
                        onChange={(e) =>
                          setResultDrafts((p) => ({
                            ...p,
                            [it.id]: { ...draft, feedback: e.target.value },
                          }))
                        }
                      />
                      <button
                        type="button"
                        className="ja-btn ja-btn--ghost ivp-save-result"
                        onClick={() => void saveResult(it)}
                      >
                        {labels.saveResult}
                      </button>
                    </div>
                  )}
                </div>
                <label className="ivp-status">
                  <span className="ja-muted ivp-status-label">{labels.status}</span>
                  <select
                    className="ja-input ivp-select"
                    value={it.status}
                    onChange={(e) => changeStatus(it, e.target.value as InterviewStatus)}
                    aria-label={labels.status}
                  >
                    {STATUS_ORDER.map((s) => (
                      <option key={s} value={s}>{labels.statusLabels[s]}</option>
                    ))}
                  </select>
                </label>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
