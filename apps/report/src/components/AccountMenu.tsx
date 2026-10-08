import { useEffect, useState } from 'react';

type AuthMe =
  | {
      kind: 'anonymous';
    }
  | {
      kind: 'demo';
      role: 'candidate' | 'recruiter';
      expiresAt: string;
    }
  | {
      kind: 'user';
      platform: 'github' | 'gitee';
      login: string;
      name: string | null;
      avatarUrl: string | null;
      profileUrl: string | null;
      claimedProfileId: string | null;
      recruiterDeclaredAt?: string | null;
      canManageLlmCatalog?: boolean;
      expiresAt: string;
    };

interface ProvidersResponse {
  github: { configured: boolean };
  gitee: { configured: boolean };
}

interface AccountMenuProps {
  apiBase: string;
  locale: 'zh-CN' | 'en';
  signInLabel: string;
  signInGiteeLabel: string;
  signOutLabel: string;
  menuLabel: string;
  myLabel: string;
  claimedLabel: string;
  recruiterBadgeLabel: string;
  declareLabel: string;
  declareConfirm: string;
  revokeLabel: string;
  revokeConfirm: string;
  actionFailedLabel: string;
}

/** providers 拉取失败时的保守默认：保留 GitHub 入口、隐藏 Gitee（避免跳到未配置的 501）。 */
const FALLBACK_PROVIDERS: ProvidersResponse = {
  github: { configured: true },
  gitee: { configured: false },
};

export default function AccountMenu({
  apiBase,
  locale,
  signInLabel,
  signInGiteeLabel,
  signOutLabel,
  menuLabel,
  myLabel,
  claimedLabel,
  recruiterBadgeLabel,
  declareLabel,
  declareConfirm,
  revokeLabel,
  revokeConfirm,
  actionFailedLabel,
}: AccountMenuProps) {
  const [me, setMe] = useState<AuthMe | null>(null);
  const [providers, setProviders] = useState<ProvidersResponse | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;

    fetch(`${apiBase}/auth/me`, { credentials: 'include' })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`auth/me ${res.status}`))))
      .then((data: AuthMe) => {
        if (!cancelled) setMe(data);
      })
      .catch(() => {
        if (!cancelled) setMe(null);
      });

    fetch(`${apiBase}/auth/providers`, { credentials: 'include' })
      .then((res) =>
        res.ok ? res.json() : Promise.reject(new Error(`auth/providers ${res.status}`)),
      )
      .then((data: ProvidersResponse) => {
        if (!cancelled) setProviders(data);
      })
      .catch(() => {
        if (!cancelled) setProviders(FALLBACK_PROVIDERS);
      });

    return () => {
      cancelled = true;
    };
  }, [apiBase]);

  const handleLogout = () => {
    fetch(`${apiBase}/auth/logout`, {
      method: 'POST',
      credentials: 'include',
    })
      .then((res) => {
        if (res.ok) window.location.reload();
      })
      .catch(() => undefined);
  };

  const setRecruiter = (declared: boolean) => {
    if (busy || me?.kind !== 'user') return;
    const confirmed = window.confirm(declared ? declareConfirm : revokeConfirm);
    if (!confirmed) return;
    setBusy(true);
    fetch(`${apiBase}/auth/recruiter`, {
      method: declared ? 'PUT' : 'DELETE',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: declared ? '{}' : undefined,
    })
      .then((res) => {
        if (!res.ok) throw new Error(`auth/recruiter ${res.status}`);
        window.location.reload();
      })
      .catch(() => {
        setBusy(false);
        window.alert(actionFailedLabel);
      });
  };

  // 首次加载前不渲染，避免闪现登录按钮
  if (!me) return null;

  if (me.kind !== 'user') {
    // 匿名 / 演示身份：仅展示已配置平台的登录入口，登录后回跳当前页
    const returnTo = encodeURIComponent(window.location.pathname + window.location.search);
    const loginHref = (platform: 'github' | 'gitee') =>
      `${apiBase}/auth/${platform}/login?return_to=${returnTo}`;
    const enabled = providers ?? FALLBACK_PROVIDERS;
    return (
      <div className="account-menu" role="navigation" aria-label={menuLabel}>
        {enabled.github.configured && (
          <a
            className="account-menu__signin"
            href={loginHref('github')}
            data-testid="signin-github"
          >
            {signInLabel}
          </a>
        )}
        {enabled.gitee.configured && (
          <a
            className="account-menu__signin"
            href={loginHref('gitee')}
            data-testid="signin-gitee"
          >
            {signInGiteeLabel}
          </a>
        )}
      </div>
    );
  }

  const displayName = me.name || me.login;
  const avatar = me.avatarUrl;
  const isRecruiter = Boolean(me.recruiterDeclaredAt);

  return (
    <div className="account-menu" role="navigation" aria-label={menuLabel}>
      {me.profileUrl ? (
        <a
          className="account-menu__identity"
          href={me.profileUrl}
          target="_blank"
          rel="noopener noreferrer"
        >
          {avatar ? (
            <img className="account-menu__avatar" src={avatar} alt="" width="24" height="24" />
          ) : null}
          <span>{displayName}</span>
        </a>
      ) : (
        <span className="account-menu__identity">
          {avatar ? (
            <img className="account-menu__avatar" src={avatar} alt="" width="24" height="24" />
          ) : null}
          <span>{displayName}</span>
        </span>
      )}
      <a className="account-menu__mine" href={`/${locale}/my`}>
        {myLabel}
      </a>
      {me.claimedProfileId ? (
        <a
          className="account-menu__claim"
          href={`/${locale}/report/${me.claimedProfileId}`}
          data-testid="my-claimed-profile"
        >
          {claimedLabel}
        </a>
      ) : null}
      {isRecruiter ? (
        <span className="account-menu__recruiter-badge" data-testid="recruiter-badge">
          {recruiterBadgeLabel}
        </span>
      ) : null}
      <button
        type="button"
        className="account-menu__recruiter-toggle"
        data-testid={isRecruiter ? 'recruiter-revoke' : 'recruiter-declare-menu'}
        disabled={busy}
        onClick={() => setRecruiter(!isRecruiter)}
      >
        {isRecruiter ? revokeLabel : declareLabel}
      </button>
      <button type="button" className="account-menu__signout" onClick={handleLogout}>
        {signOutLabel}
      </button>
    </div>
  );
}
