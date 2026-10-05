/**
 * ClaimVerifier——逐条简历声明核验表面（决策 #23 批次 2，design-claim-verification §7）。
 * 同一组件挂两处：
 *   - 招聘方视图 ?view=recruiter：核验候选人公开画像（mode="recruiter"）；
 *   - 求职者视图：投递前自检自己的声明（mode="self"）。
 * 挂载身份由 SSR 保证（招聘方视图 canViewGated / 本人 canUseApplications），组件仍对
 * 401/403 做 fail-closed 收起，不做静默降级。判定只按 verdict code 渲染，绝不匹配英文句子；
 * 所有用户可见文案经 props（t()）传入，组件不硬编码。
 */
import { useEffect, useState, type FormEvent } from 'react';

type ClaimVerdict = 'supportable' | 'partial' | 'no_trace' | 'insufficient_data';

interface MatchedEvidence {
  id: string;
  url: string;
  claim: string;
}

interface ClaimVerification {
  id: string;
  claimText: string;
  verdict: ClaimVerdict;
  matchedEvidenceRefs: string[];
  matchedEvidence: MatchedEvidence[];
  confidence: number | null;
  ruleVersion: string;
  requiredEvidenceCount: number;
  createdAt: string;
}

interface ClaimVerifierLabels {
  title: string;
  hint: string;
  inputLabel: string;
  inputPlaceholder: string;
  submit: string;
  submitting: string;
  loading: string;
  error: string;
  empty: string;
  evidenceTitle: string;
  withdraw: string;
  withdrawing: string;
  verdict: Record<ClaimVerdict, string>;
}

interface ClaimVerifierProps {
  apiBase: string;
  profileId: string;
  labels: ClaimVerifierLabels;
}

export default function ClaimVerifier({ apiBase, profileId, labels }: ClaimVerifierProps) {
  const [items, setItems] = useState<ClaimVerification[] | null>(null);
  const [hidden, setHidden] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [text, setText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [actionError, setActionError] = useState(false);
  const [withdrawingId, setWithdrawingId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`${apiBase}/profiles/${encodeURIComponent(profileId)}/claim-verifications`, {
      credentials: 'include',
    })
      .then(async (res) => {
        if (res.status === 401 || res.status === 403) {
          if (!cancelled) setHidden(true);
          return null;
        }
        if (!res.ok) throw new Error(`list ${res.status}`);
        return (await res.json()) as { items: ClaimVerification[] };
      })
      .then((body) => {
        if (cancelled || !body) return;
        setItems(body.items);
      })
      .catch(() => {
        if (!cancelled) setLoadError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [apiBase, profileId]);

  if (hidden) return null;

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const claimText = text.trim();
    if (!claimText || submitting) return;
    setSubmitting(true);
    setActionError(false);
    try {
      const res = await fetch(
        `${apiBase}/profiles/${encodeURIComponent(profileId)}/claim-verifications`,
        {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: claimText }),
        },
      );
      if (res.status === 401 || res.status === 403) {
        setHidden(true);
        return;
      }
      if (!res.ok) {
        setActionError(true);
        return;
      }
      const created = (await res.json()) as ClaimVerification;
      setItems((prev) => [created, ...(prev ?? [])]);
      setText('');
    } catch {
      setActionError(true);
    } finally {
      setSubmitting(false);
    }
  };

  const handleWithdraw = async (id: string) => {
    if (withdrawingId) return;
    setWithdrawingId(id);
    setActionError(false);
    try {
      const res = await fetch(`${apiBase}/claim-verifications/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (res.status === 401 || res.status === 403) {
        setHidden(true);
        return;
      }
      if (!res.ok) {
        setActionError(true);
        return;
      }
      setItems((prev) => (prev ?? []).filter((it) => it.id !== id));
    } catch {
      setActionError(true);
    } finally {
      setWithdrawingId(null);
    }
  };

  return (
    <section className="ja-card claim-verifier" data-testid="claim-verifier">
      <h2>{labels.title}</h2>
      <p className="ja-muted">{labels.hint}</p>

      <form className="claim-verifier-form" onSubmit={handleSubmit}>
        <label htmlFor={`claim-input-${profileId}`}>{labels.inputLabel}</label>
        <textarea
          id={`claim-input-${profileId}`}
          className="claim-verifier-input"
          data-testid="claim-input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={labels.inputPlaceholder}
          rows={2}
        />
        <button type="submit" className="ja-btn" disabled={submitting || text.trim().length === 0}>
          {submitting ? labels.submitting : labels.submit}
        </button>
      </form>

      {actionError && (
        <p className="ja-alert ja-alert--warning" data-testid="claim-action-error">
          {labels.error}
        </p>
      )}

      {loadError && <p className="ja-alert ja-alert--warning">{labels.error}</p>}
      {items === null && !loadError && <p className="ja-muted">{labels.loading}</p>}
      {items !== null && items.length === 0 && <p className="ja-muted">{labels.empty}</p>}

      {items !== null && items.length > 0 && (
        <ul className="claim-verifier-list">
          {items.map((it) => (
            <li key={it.id} className={`claim-verification claim-verification--${it.verdict}`}>
              <div className="ja-flex-between">
                <span className={`ja-badge claim-verdict claim-verdict--${it.verdict}`}>
                  {labels.verdict[it.verdict]}
                </span>
                <button
                  type="button"
                  className="ja-btn ja-btn--ghost claim-withdraw"
                  onClick={() => handleWithdraw(it.id)}
                  disabled={withdrawingId === it.id}
                >
                  {withdrawingId === it.id ? labels.withdrawing : labels.withdraw}
                </button>
              </div>
              <p className="claim-text">{it.claimText}</p>
              {it.matchedEvidence.length > 0 && (
                <div className="claim-evidence">
                  <h3 className="kind-label">{labels.evidenceTitle}</h3>
                  <ul className="evidence-links">
                    {it.matchedEvidence.map((ev) => (
                      <li key={ev.id}>
                        <a href={ev.url} target="_blank" rel="noopener noreferrer">
                          {ev.claim} ↗
                        </a>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
