/**
 * 轻量空态卡（design-ui-polish-20261010.md P2 V4）。
 *
 * - 图标 + 引导文案 + 可选下一步 CTA；文案一律由调用方经 i18n 传入（本组件零硬编码文案）；
 * - 图标为内联 SVG（stroke 用 currentColor，跟随主题文字色），不引入图标库；
 * - 纯展示组件，无状态。
 */
interface EmptyStateProps {
  /** 图标名：briefcase=偏好 / search=任务 / inbox=待投 / send=已投 */
  icon: 'briefcase' | 'search' | 'inbox' | 'send';
  /** 空态主文案（i18n 已取好） */
  title: string;
  /** 可选：进一步引导说明 */
  hint?: string;
  /** 可选：下一步 CTA 按钮文案 */
  ctaLabel?: string;
  onCta?: () => void;
}

const ICONS: Record<EmptyStateProps['icon'], string> = {
  briefcase:
    '<path d="M3 7h18v13H3z" /><path d="M8 7V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v3" /><path d="M3 12h18" />',
  search:
    '<circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" />',
  inbox:
    '<path d="M3 13h4l2 3h6l2-3h4" /><path d="M3 13V6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v7" /><path d="M3 13v4a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1v-4" />',
  send: '<path d="m22 2-7 20-4-9-9-4z" /><path d="M22 2 11 13" />',
};

export default function EmptyState({ icon, title, hint, ctaLabel, onCta }: EmptyStateProps) {
  return (
    <div className="ja-empty" data-testid="empty-state">
      <span className="ja-empty__icon" aria-hidden="true">
        <svg
          viewBox="0 0 24 24"
          width="20"
          height="20"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          dangerouslySetInnerHTML={{ __html: ICONS[icon] }}
        />
      </span>
      <p className="ja-empty__title">{title}</p>
      {hint && <p className="ja-muted ja-empty__hint">{hint}</p>}
      {ctaLabel && (
        <button type="button" className="ja-btn ja-btn--sm ja-empty__cta" onClick={onCta}>
          {ctaLabel}
        </button>
      )}
    </div>
  );
}
