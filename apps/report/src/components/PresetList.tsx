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
  /** 列表下方说明：示例账号是公开分析、"信号混合/证据不足"是正常分级 */
  hintLabel: string;
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

/** 加载态骨架块：尺寸与真实条目接近，预留空间，避免数据到达时布局位移。 */
const skeletonLine = (width: string): CSSProperties => ({
  height: '14px',
  width,
});

function PresetSkeleton() {
  return (
    <div style={listStyle} aria-hidden="true">
      {[0, 1, 2].map((i) => (
        <div key={i} className="demo-preset-item" style={itemStyle}>
          <div style={metaStyle}>
            <span className="ja-skeleton" style={skeletonLine('96px')} />
            <span className="ja-skeleton" style={{ ...skeletonLine('120px'), height: '12px' }} />
          </div>
          <span
            className="ja-skeleton"
            style={{ ...skeletonLine('44px'), height: '16px', flexShrink: 0 }}
          />
        </div>
      ))}
    </div>
  );
}

export default function PresetList({ locale, apiBase, title, viewLabel, authLabels, hintLabel }: PresetListProps) {
  const [presets, setPresets] = useState<DemoPreset[]>([]);
  // 加载态：首屏水合后 fetch 完成前展示骨架，而不是 return null（消除空白与 CLS）。
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetch(`${apiBase}/demo/presets`, { credentials: 'include' })
      .then((r) => r.json())
      .then((data: DemoPreset[]) => {
        if (!cancelled) {
          setPresets(data.filter((p) => p.ready && p.profileId));
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setPresets([]);
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [apiBase]);

  // 加载中：渲染带标题的骨架区域（aria-busy），AX tree 首屏即有可识别节点。
  if (loading) {
    return (
      <div
        className="demo-presets"
        style={wrapStyle}
        aria-busy="true"
        aria-live="polite"
        data-testid="preset-list-loading"
      >
        <h2 style={{ fontSize: 'var(--ja-text-base)', textAlign: 'center' }}>{title}</h2>
        <p className="demo-presets-hint" style={mutedStyle}>{hintLabel}</p>
        <PresetSkeleton />
      </div>
    );
  }

  if (presets.length === 0) return null;

  return (
    <div className="demo-presets" style={wrapStyle}>
      <h2 style={{ fontSize: 'var(--ja-text-base)', textAlign: 'center' }}>{title}</h2>
      <p className="demo-presets-hint" style={mutedStyle}>{hintLabel}</p>
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
