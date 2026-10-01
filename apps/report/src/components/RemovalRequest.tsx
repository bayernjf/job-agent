import { useState } from 'react';

/**
 * RemovalRequest：未认领画像的「按主体撤回」公开申请入口（审计 S3，2026-10-01）。
 * 仅在 SSR 画像 claimed=false 且尚未软挂起（removal_requested_at 为空）时挂载；
 * 挂载后向 POST /profiles/:id/removal-request 提交申请（匿名即可，服务端按 IP 滑窗防刷）。
 * 提交成功（202）或命中幂等（200 idempotent）后刷新页面，由 SSR 顶部「已收到移除申请」
 * 标注条接管显示；失败显示错误文案。所有用户可见文案由 Astro 经 t() 传入，组件不硬编码。
 */

type UiStatus = 'idle' | 'submitting' | 'done' | 'error';

interface RemovalRequestProps {
  apiBase: string;
  profileId: string;
  ctaLabel: string;
  submittingLabel: string;
  submittedLabel: string;
  errorLabel: string;
  reasonPlaceholder: string;
  contactPlaceholder: string;
  hintLabel: string;
}

export default function RemovalRequest({
  apiBase,
  profileId,
  ctaLabel,
  submittingLabel,
  submittedLabel,
  errorLabel,
  reasonPlaceholder,
  contactPlaceholder,
  hintLabel,
}: RemovalRequestProps) {
  const [status, setStatus] = useState<UiStatus>('idle');
  const [reason, setReason] = useState('');
  const [contact, setContact] = useState('');

  const handleSubmit = async () => {
    setStatus('submitting');
    try {
      const res = await fetch(
        `${apiBase}/profiles/${encodeURIComponent(profileId)}/removal-request`,
        {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            reason: reason.trim() || undefined,
            contact: contact.trim() || undefined,
          }),
        },
      );
      if (res.status === 202 || res.status === 200) {
        // 202 新申请 / 200 幂等命中：刷新页面，由 SSR 软挂起标注条接管
        window.location.reload();
        return;
      }
      setStatus('error');
    } catch {
      setStatus('error');
    }
  };

  if (status === 'done') {
    return (
      <p className="removal-request removal-request--done" data-testid="removal-done" role="status">
        {submittedLabel}
      </p>
    );
  }

  return (
    <details className="removal-request" data-testid="removal-request">
      <summary className="ja-btn ja-btn--ghost" role="button" aria-expanded="false">
        {ctaLabel}
      </summary>
      <p className="ja-muted removal-request__hint">{hintLabel}</p>
      <textarea
        className="removal-request__field"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder={reasonPlaceholder}
        rows={3}
        maxLength={2000}
        aria-label={reasonPlaceholder}
      />
      <input
        className="removal-request__field"
        type="text"
        value={contact}
        onChange={(e) => setContact(e.target.value)}
        placeholder={contactPlaceholder}
        maxLength={500}
        aria-label={contactPlaceholder}
      />
      <button
        type="button"
        className="ja-btn"
        onClick={handleSubmit}
        disabled={status === 'submitting'}
        data-testid="removal-submit"
      >
        {status === 'submitting' ? submittingLabel : ctaLabel}
      </button>
      {status === 'error' && (
        <p className="removal-request__error" role="alert">
          {errorLabel}
        </p>
      )}
    </details>
  );
}
