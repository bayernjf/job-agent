/**
 * ShareButton——客户端 React island。
 * 复制当前报告链接到剪贴板，显示"已复制"反馈。
 * 文案由 Astro 服务端通过 props 传入。
 *
 * 漏斗埋点（design-funnel-analytics-20261015 §5.3）：复制成功后 fire-and-forget
 * POST /funnel/events（keepalive），不 await、不提示、不影响复制行为；
 * 上报失败被静默吞掉——分享行为绝不因埋点而降级。
 */

import { useState, useCallback } from 'react';

interface ShareButtonProps {
  url: string;
  copyLabel: string;
  copiedLabel: string;
  /** API 基址（浏览器侧，报告页 SSR 注入） */
  apiBase: string;
  /** 报告画像 id（share_clicked 事件的可选上下文） */
  profileId: string;
}

export default function ShareButton({
  url,
  copyLabel,
  copiedLabel,
  apiBase,
  profileId,
}: ShareButtonProps) {
  const [copied, setCopied] = useState(false);

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
    // 漏斗：share_clicked（fire-and-forget；失败静默，不影响复制反馈）
    // credentials:'include' 必带——端点从 cookie 读 ja_sid 串联会话（且仓库
    // credentials-guard 要求组件内每个 fetch 都带凭证）
    fetch(`${apiBase}/funnel/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ event: 'share_clicked', profileId }),
      keepalive: true,
    }).catch(() => {});
  }, [url, apiBase, profileId]);

  return (
    <button
      type="button"
      className={`share-btn ${copied ? 'share-btn--copied' : ''}`}
      onClick={handleCopy}
      aria-live="polite"
    >
      {copied ? copiedLabel : copyLabel}
    </button>
  );
}
