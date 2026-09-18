import { useEffect, useState } from 'react';

/**
 * ClaimProfile：报告页头部的「本人认领」入口（账号主脊 item28-⑤）。
 * 仅在 SSR 画像 claimed=false 时挂载；挂载后拉 /auth/me：
 * - 登录用户的 platform+login 与画像主体完全一致 → 显示认领按钮；
 *   已认领该画像（claimedProfileId 命中）或认领成功后显示「本人已验证」徽章；
 * - 匿名/演示/登录但非本人 → 不渲染（不打扰浏览他人画像，也不做授权分级折叠）。
 * 所有用户可见文案由 Astro 经 t() 传入，组件不硬编码。
 */

type AuthMe =
  | { kind: 'anonymous' }
  | { kind: 'demo' }
  | {
      kind: 'user';
      platform: 'github' | 'gitee';
      login: string;
      claimedProfileId?: string | null;
    };

type UiStatus = 'loading' | 'eligible' | 'claiming' | 'claimed' | 'hidden' | 'error';

interface ClaimProfileProps {
  apiBase: string;
  profileId: string;
  subjectPlatform: 'github' | 'gitee';
  subjectLogin: string;
  ctaLabel: string;
  claimingLabel: string;
  claimedBadge: string;
  errorLabel: string;
  hintLabel: string;
}

export default function ClaimProfile({
  apiBase,
  profileId,
  subjectPlatform,
  subjectLogin,
  ctaLabel,
  claimingLabel,
  claimedBadge,
  errorLabel,
  hintLabel,
}: ClaimProfileProps) {
  const [status, setStatus] = useState<UiStatus>('loading');

  useEffect(() => {
    let cancelled = false;
    fetch(`${apiBase}/auth/me`, { credentials: 'same-origin' })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`auth/me ${res.status}`))))
      .then((me: AuthMe) => {
        if (cancelled) return;
        if (
          me.kind === 'user' &&
          me.platform === subjectPlatform &&
          me.login === subjectLogin
        ) {
          setStatus(me.claimedProfileId === profileId ? 'claimed' : 'eligible');
        } else {
          setStatus('hidden');
        }
      })
      .catch(() => {
        if (!cancelled) setStatus('hidden');
      });
    return () => {
      cancelled = true;
    };
  }, [apiBase, profileId, subjectPlatform, subjectLogin]);

  const handleClaim = async () => {
    setStatus('claiming');
    try {
      const res = await fetch(`${apiBase}/profiles/${encodeURIComponent(profileId)}/claim`, {
        method: 'POST',
        credentials: 'same-origin',
      });
      if (res.ok) {
        setStatus('claimed');
      } else if (res.status === 401 || res.status === 403) {
        // 登录态失效或并非本人：收起入口
        setStatus('hidden');
      } else {
        setStatus('error');
      }
    } catch {
      setStatus('error');
    }
  };

  if (status === 'loading' || status === 'hidden') return null;

  if (status === 'claimed') {
    return (
      <span className="ja-badge ja-badge--owner" data-testid="claimed-badge">
        {claimedBadge}
      </span>
    );
  }

  if (status === 'error') {
    return (
      <span className="claim-profile">
        <span className="claim-profile__error" role="alert">
          {errorLabel}
        </span>
        <button type="button" className="ja-btn ja-btn--ghost" onClick={handleClaim}>
          {ctaLabel}
        </button>
      </span>
    );
  }

  return (
    <span className="claim-profile" title={hintLabel}>
      <button
        type="button"
        className="ja-btn"
        onClick={handleClaim}
        disabled={status === 'claiming'}
        data-testid="claim-button"
      >
        {status === 'claiming' ? claimingLabel : ctaLabel}
      </button>
    </span>
  );
}
