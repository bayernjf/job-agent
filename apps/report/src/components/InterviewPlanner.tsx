/**
 * InterviewPlanner——求职者版「我的面试管道」（T18，挂载于 /[locale]/my）。
 * 登录后自动解析"我的画像"（认领画像优先，否则 by-subject 公开解析最新画像），
 * 列出该画像的投递记录（我投了哪些）与面试（哪场面试 → 结果如何）。
 * 建行从"我的投递"选 applicationId 真接上（API 将 saved/applied/viewed 推进为 interview），
 * 不再要求"进前 100 候选人"才能建行。不做物理删除：取消/爽约走 status=cancelled/no_show。
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

/** 投递记录（applications）：建行时从 saved/applied/viewed 里选，真接上 applicationId。 */
interface Application {
  id: string;
  profileId: string;
  jobId: string | null;
  targetTitle: string;
  targetCompany: string | null;
  status: string;
  appliedAt: string;
}

interface AuthMe {
  kind: 'anonymous' | 'demo' | 'user';
  platform?: 'github' | 'gitee';
  login?: string;
  claimedProfileId?: string | null;
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
  application: string;
  applicationNone: string;
  applicationPlaceholder: string;
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
  noProfile: string;
  noProfileAction: string;
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
/** 只有早期阶段投递能推进为面试（终态不回退，与 API 一致）。 */
const BUILDABLE_STATUSES = new Set(['saved', 'applied', 'viewed']);

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
  const [profileId, setProfileId] = useState<string | null>(null);
  const [applications, setApplications] = useState<Application[]>([]);
  const [items, setItems] = useState<Interview[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [noProfile, setNoProfile] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // 表单字段
  const [applicationId, setApplicationId] = useState('');
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

  /** 解析"我的画像"：认领画像优先，否则 by-subject 公开解析最新画像（T18 不再依赖候选人列表）。 */
  async function resolveMyProfile(user: AuthMe): Promise<string | null> {
    if (user.claimedProfileId) return user.claimedProfileId;
    if (!user.platform || !user.login) return null;
    try {
      const res = await fetch(
        `${apiBase}/profiles/by-subject/${encodeURIComponent(user.platform)}/${encodeURIComponent(user.login)}`,
        { credentials: 'include' },
      );
      if (!res.ok) return null;
      const body = (await res.json()) as { id?: string };
      return body.id ?? null;
    } catch {
      return null;
    }
  }

  async function load(pid: string) {
    setLoading(true);
    setError(null);
    try {
      const [appRes, intRes] = await Promise.all([
        fetch(`${apiBase}/profiles/${encodeURIComponent(pid)}/applications`, { credentials: 'include' }),
        fetch(`${apiBase}/interviews?profileId=${encodeURIComponent(pid)}`, { credentials: 'include' }),
      ]);
      if (!appRes.ok) throw new Error(`applications HTTP ${appRes.status}`);
      if (!intRes.ok) throw new Error(`interviews HTTP ${intRes.status}`);
      const appBody = (await appRes.json()) as { items: Application[] };
      const intBody = (await intRes.json()) as { items: Interview[] };
      setApplications(appBody.items ?? []);
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
        if (auth.kind === 'user') {
          const pid = await resolveMyProfile(auth);
          if (cancelled) return;
          if (!pid) {
            setNoProfile(true);
            setLoading(false);
            return;
          }
          setProfileId(pid);
          await load(pid);
        } else {
          setLoading(false);
        }
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

  const buildable = applications.filter((a) => BUILDABLE_STATUSES.has(a.status));

  function selectApplication(appId: string) {
    setApplicationId(appId);
    const app = applications.find((a) => a.id === appId);
    if (app) {
      setRole(app.targetTitle);
      if (app.targetCompany) setCompany(app.targetCompany);
    }
  }

  function resetForm() {
    setApplicationId('');
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
      if (applicationId) payload.applicationId = applicationId;
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
      void load(profileId ?? '');
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

  // 登录但还没有本人画像：引导去生成（不再要求"进前 100 候选人"）
  if (noProfile) {
    return (
      <section className="ja-card ivp" data-testid="interview-no-profile">
        <h2>{labels.title}</h2>
        <p className="ja-muted">{labels.noProfile}</p>
        <a className="ja-btn" href={`/${locale}/`}>
          {labels.noProfileAction}
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
            <label htmlFor="ivp-application">{labels.application}</label>
            <select
              id="ivp-application"
              className="ja-input"
              value={applicationId}
              onChange={(e) => selectApplication(e.target.value)}
            >
              <option value="">{labels.applicationNone}</option>
              {buildable.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.targetCompany ? `${a.targetCompany} · ` : ''}{a.targetTitle}
                </option>
              ))}
            </select>
            {buildable.length === 0 && (
              <p className="ja-muted ivp-field-hint">{labels.applicationPlaceholder}</p>
            )}
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
                    <strong>{it.targetTitle}</strong>
                    {it.targetCompany && <span className="ja-muted">· {it.targetCompany}</span>}
                    {it.applicationId && (
                      <span className="ivp-item-app ja-muted">· {labels.application}</span>
                    )}
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
                          {[1, 2, 3, 4, 5].map((r) => (
                            <option key={r} value={r}>{r}</option>
                          ))}
                        </select>
                      </label>
                      <label className="ivp-result-field ivp-result-field--wide">
                        <span className="ja-muted">{labels.feedback}</span>
                        <textarea
                          className="ja-input"
                          rows={2}
                          value={draft.feedback}
                          placeholder={labels.feedbackPlaceholder}
                          onChange={(e) =>
                            setResultDrafts((p) => ({
                              ...p,
                              [it.id]: { ...draft, feedback: e.target.value },
                            }))
                          }
                        />
                      </label>
                      <div className="ivp-result-actions">
                        <button
                          type="button"
                          className="ja-btn ja-btn--ghost"
                          disabled={submitting}
                          onClick={() => void saveResult(it)}
                        >
                          {labels.saveResult}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
                <div className="ivp-item-side">
                  <label className="ivp-status">
                    <span className="ja-muted">{labels.status}</span>
                    <select
                      className="ja-input"
                      value={it.status}
                      onChange={(e) => changeStatus(it, e.target.value as InterviewStatus)}
                    >
                      {STATUS_ORDER.map((s) => (
                        <option key={s} value={s}>{labels.statusLabels[s]}</option>
                      ))}
                    </select>
                  </label>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
