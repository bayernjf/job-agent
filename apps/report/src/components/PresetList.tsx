/**
 * PresetList——客户端 React island（演示模式首页）。
 * 职责：拉取 GET /demo/presets，只展示 ready=true 的预置示例，点击直接进入已生成报告页
 * （走画像快照，不触发新分析、不消耗演示配额）。无就绪示例时不渲染。
 * 文案由 Astro 服务端经 props 传入；颜色/间距只用 --ja-* token。
 */
import { useEffect, useState, type CSSProperties } from 'react';

interface DemoPreset {
  platform: 'github' | 'gitee';
  login: string;
  authenticity: string;
  profileId: string | null;
  ready: boolean;
}

interface PresetListProps {
  locale: string;
  apiBase: string;
  title: string;
  viewLabel: string;
  /** authenticity 状态码 → 本地化文案（来自 report.authenticity.* ） */
  authLabels: Record<string, string>;
}

const wrapStyle: CSSProperties = {
  maxWidth: 480,
  margin: 'var(--ja-space-5) auto 0',
  textAlign: 'left',
};

const listStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--ja-space-2)',
  marginTop: 'var(--ja-space-3)',
};

const itemStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 'var(--ja-space-3)',
  padding: 'var(--ja-space-3)',
  border: '1px solid var(--ja-color-border)',
  borderRadius: 'var(--ja-radius-md)',
  background: 'var(--ja-color-surface)',
};

const metaStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '2px',
  fontSize: 'var(--ja-text-sm)',
};

const loginStyle: CSSProperties = { fontWeight: 600, color: 'var(--ja-color-fg)' };
const mutedStyle: CSSProperties = { color: 'var(--ja-color-fg-muted)', fontSize: 'var(--ja-text-xs)' };
const linkStyle: CSSProperties = {
  flexShrink: 0,
  fontSize: 'var(--ja-text-sm)',
  color: 'var(--ja-color-accent)',
};

export default function PresetList({ locale, apiBase, title, viewLabel, authLabels }: PresetListProps) {
  const [presets, setPresets] = useState<DemoPreset[]>([]);

  useEffect(() => {
    let cancelled = false;
    fetch(`${apiBase}/demo/presets`, { credentials: 'same-origin' })
      .then((r) => r.json())
      .then((data: DemoPreset[]) => {
        if (!cancelled) setPresets(data.filter((p) => p.ready && p.profileId));
      })
      .catch(() => {
        if (!cancelled) setPresets([]);
      });
    return () => {
      cancelled = true;
    };
  }, [apiBase]);

  if (presets.length === 0) return null;

  return (
    <div className="demo-presets" style={wrapStyle}>
      <h2 style={{ fontSize: 'var(--ja-text-base)', textAlign: 'center' }}>{title}</h2>
      <div style={listStyle}>
        {presets.map((preset) => (
          <div className="demo-preset-item" key={`${preset.platform}:${preset.login}`} style={itemStyle}>
            <div style={metaStyle}>
              <span style={loginStyle}>{preset.login}</span>
              <span style={mutedStyle}>
                {preset.platform} · {authLabels[preset.authenticity] ?? preset.authenticity}
              </span>
            </div>
            <a style={linkStyle} href={`/${locale}/report/${preset.profileId}`}>
              {viewLabel}
            </a>
          </div>
        ))}
      </div>
    </div>
  );
}
