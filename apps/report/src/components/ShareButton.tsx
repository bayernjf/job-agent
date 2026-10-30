/**
 * ShareButton——客户端 React island（决策 #30，design-share-sheet-20261030）。
 * 「分享」菜单：复制链接 / 系统分享 / 各平台官方分享入口。
 *
 * 合规硬边界（决策 #30）：只走平台官方无鉴权 intent 入口与浏览器标准
 * Web Share API——发布动作永远由用户本人在平台页面上完成；绝不接平台
 * 发帖 API、绝不自动化用户会话（代发永久禁止）。预填文案由 SSR 现拼
 * 传入，组件不写自然语言。
 *
 * 漏斗埋点（design-funnel-analytics-20261015 §5.3）：菜单内任何分享动作
 * 成功触发后 fire-and-forget POST /funnel/events（keepalive），不 await、
 * 不提示；上报失败静默吞掉——分享行为绝不因埋点而降级。
 */

import { useState, useCallback, useEffect, useRef } from 'react';

interface ShareButtonProps {
  url: string;
  copyLabel: string;
  copiedLabel: string;
  /** API 基址（浏览器侧，报告页 SSR 注入） */
  apiBase: string;
  /** 报告画像 id（share_clicked 事件的可选上下文） */
  profileId: string;
  /** 预填文案（SSR 现拼，含主体 login 与可复核提示） */
  shareText: string;
  systemShareLabel: string;
  xLabel: string;
  linkedinLabel: string;
  redditLabel: string;
  telegramLabel: string;
  weiboLabel: string;
  wechatHint: string;
}

/** 平台官方 intent 入口（全部无鉴权、文档化；只读平台常量，无账号逻辑） */
function intentUrls(url: string, text: string): { key: 'x' | 'linkedin' | 'reddit' | 'telegram' | 'weibo'; href: string }[] {
  const u = encodeURIComponent(url);
  const t = encodeURIComponent(text);
  return [
    { key: 'x', href: `https://twitter.com/intent/tweet?text=${t}&url=${u}` },
    { key: 'linkedin', href: `https://www.linkedin.com/sharing/share-offsite/?url=${u}` },
    { key: 'reddit', href: `https://www.reddit.com/submit?url=${u}&title=${t}` },
    { key: 'telegram', href: `https://t.me/share/url?url=${u}&text=${t}` },
    { key: 'weibo', href: `https://service.weibo.com/share/share.php?url=${u}&title=${t}` },
  ];
}

export default function ShareButton({
  url,
  copyLabel,
  copiedLabel,
  apiBase,
  profileId,
  shareText,
  systemShareLabel,
  xLabel,
  linkedinLabel,
  redditLabel,
  telegramLabel,
  weiboLabel,
  wechatHint,
}: ShareButtonProps) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // 漏斗：share_clicked（fire-and-forget；失败静默，不影响分享动作）。
  // credentials:'include' 必带——端点从 cookie 读 ja_sid 串联会话（且仓库
  // credentials-guard 要求组件内每个 fetch 都带凭证）。
  const fireFunnel = useCallback(() => {
    fetch(`${apiBase}/funnel/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ event: 'share_clicked', profileId }),
      keepalive: true,
    }).catch(() => {});
  }, [apiBase, profileId]);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      // 兜底：旧浏览器用临时 input
      const input = document.createElement('input');
      input.value = url;
      document.body.appendChild(input);
      input.select();
      document.execCommand('copy');
      document.body.removeChild(input);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
    fireFunnel();
  }, [url, fireFunnel]);

  const handleSystemShare = useCallback(() => {
    // 只在 navigator.share 存在时渲染该菜单项（能力检测在渲染层）
    navigator
      .share({ title: shareText, text: shareText, url })
      .then(fireFunnel)
      .catch((err: unknown) => {
        // 用户在系统面板取消 = AbortError，静默即可
        if ((err as { name?: string })?.name !== 'AbortError') fireFunnel();
      });
    setOpen(false);
  }, [shareText, url, fireFunnel]);

  const handlePlatformShare = useCallback(
    (href: string) => {
      window.open(href, '_blank', 'noopener,noreferrer');
      fireFunnel();
      setOpen(false);
    },
    [fireFunnel],
  );

  // 打开时：Escape 关闭 + 点击外部关闭
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    const onPointerDown = (e: PointerEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open]);

  const canSystemShare = typeof navigator.share === 'function';
  const platformLabels: Record<'x' | 'linkedin' | 'reddit' | 'telegram' | 'weibo', string> = {
    x: xLabel,
    linkedin: linkedinLabel,
    reddit: redditLabel,
    telegram: telegramLabel,
    weibo: weiboLabel,
  };

  return (
    <div className="share-menu" ref={rootRef}>
      <button
        type="button"
        className={`share-btn ${copied ? 'share-btn--copied' : ''}`}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-live="polite"
      >
        {copied ? copiedLabel : copyLabel}
      </button>
      {open && (
        <div className="share-menu__panel" role="menu" data-testid="share-menu-panel">
          <button type="button" role="menuitem" className="share-menu__item" onClick={handleCopy}>
            {copied ? copiedLabel : copyLabel}
          </button>
          {canSystemShare && (
            <button type="button" role="menuitem" className="share-menu__item" onClick={handleSystemShare}>
              {systemShareLabel}
            </button>
          )}
          {intentUrls(url, shareText).map(({ key, href }) => (
            <button
              key={key}
              type="button"
              role="menuitem"
              className="share-menu__item"
              onClick={() => handlePlatformShare(href)}
            >
              {platformLabels[key]}
            </button>
          ))}
          <p className="share-menu__hint">{wechatHint}</p>
        </div>
      )}
    </div>
  );
}
