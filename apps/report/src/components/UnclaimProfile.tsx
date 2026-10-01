import { useEffect, useState } from 'react';

/**
 * UnclaimProfile：报告页头部的「解除认领」入口（PRD F8「可解绑」的非破坏版本）。
 * 仅在 SSR 画像 claimed=true 时挂载；挂载后拉 /auth/me：
 * - 登录用户的 platform+login 与画像主体一致 → 显示解除认领按钮；
 * - 匿名/演示/登录但非本人 → 不渲染（他人只能看到静态「本人已验证」徽章）。
 * 解除认领只翻归属标记：画像、证据、投递、面试与分享链接全部保留，
 * 成功后整页刷新，让 SSR 回到未认领的公开只读态。
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

type UiStatus = 'loading' | 'eligible' | 'unclaiming' | 'hidden' | 'error';

interface UnclaimProfileProps {
  apiBase: string;
  profileId: string;
  subjectPlatform: 'github' | 'gitee' | 'all';
  subjectLogin: string;
  ctaLabel: string;
  confirmMessage: string;
  unclaimingLabel: string;
  errorLabel: string;
  hintLabel: string;
}

export default function UnclaimProfile({
  apiBase,
  profileId,
  subjectPlatform,
  subjectLogin,
  ctaLabel,
  confirmMessage,
  unclaimingLabel,
  errorLabel,
  hintLabel,
}: UnclaimProfileProps) {
  const [status, setStatus] = useState<UiStatus>('loading');

  useEffect(() => {
    let cancelled = false;
    fetch(`${apiBase}/auth/me`, { credentials: 'include' })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`auth/me ${res.status}`))))
      .then((me: AuthMe) => {
        if (cancelled) return;
        const matches =
          me.kind === 'user' &&
          (subjectPlatform === 'all'
            ? me.login === subjectLogin
            : me.platform === subjectPlatform && me.login === subjectLogin);
        setStatus(matches ? 'eligible' : 'hidden');
      })
      .catch(() => {
        if (!cancelled) setStatus('hidden');
      });
    return () => {
      cancelled = true;
    };
  }, [apiBase, subjectPlatform, subjectLogin]);

  const handleUnclaim = async () => {
    if (typeof window !== 'undefined' && !window.confirm(confirmMessage)) return;
    setStatus('unclaiming');
    try {
      const res = await fetch(`${apiBase}/profiles/${encodeURIComponent(profileId)}/unclaim`, {
        method: 'POST',
        credentials: 'include',
      });
      if (res.ok) {
        // 整页刷新：SSR 重新按未认领态渲染（投递区块等回到公开挂载）
        if (typeof window !== 'undefined') window.location.reload();
      } else if (res.status === 401 || res.status === 403) {
        setStatus('hidden');
      } else {
        setStatus('error');
      }
    } catch {
      setStatus('error');
    }
  };

  if (status === 'loading' || status === 'hidden') return null;

  if (status === 'error') {
    return (
      <span className="claim-profile">
        <span className="claim-profile__error" role="alert">
          {errorLabel}
        </span>
        <button type="button" className="ja-btn ja-btn--ghost" onClick={handleUnclaim}>
          {ctaLabel}
        </button>
      </span>
    );
  }

  return (
    <span className="claim-profile" title={hintLabel}>
      <button
        type="button"
        className="ja-btn ja-btn--ghost"
        onClick={handleUnclaim}
        disabled={status === 'unclaiming'}
        data-testid="unclaim-button"
      >
        {status === 'unclaiming' ? unclaimingLabel : ctaLabel}
      </button>
    </span>
  );
}
