/**
 * ShareButton——客户端 React island。
 * 复制当前报告链接到剪贴板，显示"已复制"反馈。
 * 文案由 Astro 服务端通过 props 传入。
 */

import { useState, useCallback } from 'react';

interface ShareButtonProps {
  url: string;
  copyLabel: string;
  copiedLabel: string;
}

export default function ShareButton({ url, copyLabel, copiedLabel }: ShareButtonProps) {
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
  }, [url]);

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
