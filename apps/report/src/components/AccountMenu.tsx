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
      expiresAt: string;
    };

interface ProvidersResponse {
  github: { configured: boolean };
  gitee: { configured: boolean };
}

interface AccountMenuProps {
  apiBase: string;
  signInLabel: string;
  signInGiteeLabel: string;
  signOutLabel: string;
  menuLabel: string;
}

/** providers 拉取失败时的保守默认：保留 GitHub 入口、隐藏 Gitee（避免跳到未配置的 501）。 */
const FALLBACK_PROVIDERS: ProvidersResponse = {
  github: { configured: true },
  gitee: { configured: false },
};

export default function AccountMenu({
  apiBase,
  signInLabel,
  signInGiteeLabel,
  signOutLabel,
  menuLabel,
}: AccountMenuProps) {
  const [me, setMe] = useState<AuthMe | null>(null);
  const [providers, setProviders] = useState<ProvidersResponse | null>(null);

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
      <button type="button" className="account-menu__signout" onClick={handleLogout}>
        {signOutLabel}
      </button>
    </div>
  );
}
