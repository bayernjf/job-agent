/**
 * DemoBanner——客户端 React island。
 * 职责：拉取 GET /demo/me，仅当处于演示会话时显示一条全局提示条，
 * 展示剩余新分析次数并提供"退出演示"（POST /demo/exit 后刷新回到匿名态）。
 * 文案全部由 Astro 服务端经 props 传入，组件不硬编码用户可见文案；颜色/间距只用 --ja-* token。
 */
import { useEffect, useState, type CSSProperties } from 'react';

type DemoMe =
  | { kind: 'anonymous' }
  | {
      kind: 'demo';
      analyzeQuota: number;
      analyzeUsed: number;
      analyzeRemaining: number;
      expiresAt: string;
    };

interface DemoBannerProps {
  apiBase: string;
  label: string;
  remainingLabel: string;
  exitLabel: string;
}

const bannerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 'var(--ja-space-3)',
  flexWrap: 'wrap',
  padding: 'var(--ja-space-2) var(--ja-space-4)',
  background: 'var(--ja-color-accent-subtle)',
  borderBottom: '1px solid var(--ja-color-border)',
  fontSize: 'var(--ja-text-sm)',
  color: 'var(--ja-color-fg)',
};

const tagStyle: CSSProperties = {
  fontWeight: 600,
  color: 'var(--ja-color-accent)',
};

const exitButtonStyle: CSSProperties = {
  border: '1px solid var(--ja-color-border)',
  borderRadius: 'var(--ja-radius-sm)',
  background: 'var(--ja-color-surface)',
  color: 'var(--ja-color-fg)',
  padding: '2px var(--ja-space-3)',
  fontSize: 'var(--ja-text-xs)',
  cursor: 'pointer',
};

export default function DemoBanner({ apiBase, label, remainingLabel, exitLabel }: DemoBannerProps) {
  const [me, setMe] = useState<DemoMe | null>(null);
  const [exiting, setExiting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`${apiBase}/demo/me`, { credentials: 'include' })
      .then((r) => r.json())
      .then((data: DemoMe) => {
        if (!cancelled) setMe(data);
      })
      .catch(() => {
        if (!cancelled) setMe({ kind: 'anonymous' });
      });
    return () => {
      cancelled = true;
    };
  }, [apiBase]);

  const handleExit = async () => {
    setExiting(true);
    try {
      await fetch(`${apiBase}/demo/exit`, { method: 'POST', credentials: 'include' });
    } finally {
      window.location.reload();
    }
  };

  // 匿名或尚未加载完成时不占位
  if (!me || me.kind !== 'demo') return null;

  return (
    <div className="demo-banner" role="status" style={bannerStyle}>
      <span style={tagStyle}>{label}</span>
      <span>{remainingLabel.replace('{remaining}', String(me.analyzeRemaining))}</span>
      <button type="button" style={exitButtonStyle} onClick={handleExit} disabled={exiting}>
        {exitLabel}
      </button>
    </div>
  );
}
