import { useEffect, useState } from 'react';

/**
 * AccountMenu：报告站点全局头部的登录态入口（账号主脊 item28-⑤）。
 * - 匿名/演示：显示「用 GitHub 登录」，整页跳转到后端 OAuth 发起端点（HttpOnly Cookie 流）。
 * - 已登录：显示头像 + 登录名/展示名 + 退出；退出调 POST /auth/logout 后整页刷新。
 * 拉取 /auth/me 失败（如 API 不可达）时静默不渲染，避免在无后端环境留下坏入口。
 * 所有用户可见文案由 Astro 经 t() 传入，组件不硬编码。
 */

type AuthMe =
  | { kind: 'anonymous' }
  | { kind: 'demo' }
  | {
      kind: 'user';
      platform: 'github' | 'gitee';
      login: string;
      name?: string | null;
      avatarUrl?: string | null;
    };

interface AccountMenuProps {
  apiBase: string;
  signInLabel: string;
  signOutLabel: string;
  menuLabel: string;
}

export default function AccountMenu({
  apiBase,
  signInLabel,
  signOutLabel,
  menuLabel,
}: AccountMenuProps) {
  const [me, setMe] = useState<AuthMe | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`${apiBase}/auth/me`, { credentials: 'same-origin' })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`auth/me ${res.status}`))))
      .then((data: AuthMe) => {
        if (!cancelled) setMe(data);
      })
      .catch(() => {
        if (!cancelled) setMe(null);
      });
    return () => {
      cancelled = true;
    };
  }, [apiBase]);

  const handleLogout = async () => {
    try {
      await fetch(`${apiBase}/auth/logout`, {
        method: 'POST',
        credentials: 'same-origin',
      });
    } finally {
      // 无论后端响应如何都刷新回匿名视图（后端对匿名是 no-op）
      window.location.reload();
    }
  };

  // 首次拉取未完成或拉取失败：不渲染，避免闪烁/坏入口
  if (!me) return null;

  if (me.kind !== 'user') {
    return (
      <div className="account-menu" role="navigation" aria-label={menuLabel}>
        <a className="account-menu__signin" href={`${apiBase}/auth/github/login`}>
          {signInLabel}
        </a>
      </div>
    );
  }

  return (
    <div className="account-menu" role="navigation" aria-label={menuLabel}>
      <span className="account-menu__identity">
        {me.avatarUrl ? (
          <img className="account-menu__avatar" src={me.avatarUrl} alt="" width={22} height={22} />
        ) : null}
        <span className="account-menu__login">{me.name ?? me.login}</span>
      </span>
      <button type="button" className="account-menu__logout" onClick={handleLogout}>
        {signOutLabel}
      </button>
    </div>
  );
}
