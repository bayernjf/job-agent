/**
 * 报告页右侧章节锚点导航（design-ui-polish-20261010.md V3）。
 *
 * - 纯展示 + 滚动高亮：IntersectionObserver 观察各章节 id，进入视口顶部区域的章节高亮；
 * - 点击锚点走原生 href 平滑滚动（CSS scroll-behavior: smooth + 章节 scroll-margin-top）；
 * - <960px 由 CSS 隐藏（report-page.css，与 --ja-breakpoint-lg 对齐）；
 * - 窄屏无锚点导航时提供固定「返回顶部」按钮（P1-7）：宽屏 CSS 隐藏、<960px 显示；
 *   按钮与 TOC 同属一个 island，避免为单个按钮再引入一次 React hydrate。
 *
 * 用户可见文案（aria-label / 按钮文本）由 Astro 侧经 t() 传入，组件内不硬编码。
 */
import { useEffect, useRef, useState } from 'react';

export interface ReportTocItem {
  id: string;
  label: string;
}

interface Props {
  items: ReportTocItem[];
  ariaLabel: string;
  /** 窄屏返回顶部按钮文本；未提供（如单测旧调用）时不渲染按钮 */
  backToTopLabel?: string;
}

export default function ReportToc({ items, ariaLabel, backToTopLabel }: Props) {
  const [activeId, setActiveId] = useState<string>(items[0]?.id ?? '');
  const [hydrated, setHydrated] = useState(false);
  const observerRef = useRef<IntersectionObserver | null>(null);

  useEffect(() => {
    // hydrate 完成信号（SSR 也会输出 <nav>，但事件监听此时才挂上；
    // E2E 用 data-hydrated 等待 React 接管后再点击，避免 CI 慢速加载下点击丢失）
    setHydrated(true);
    if (items.length === 0) return;
    const sections = items
      .map((item) => document.getElementById(item.id))
      .filter((el): el is HTMLElement => el !== null);
    if (sections.length === 0) return;

    // 「当前章节」判定带：视口顶部 72px 起、40% 视口高度止（与 rootMargin 同源，
    // 两个常量只此一处定义）。顶部 -72px 与章节 scroll-margin-top:88px 错开
    // （88px 停在判定带 72px 起点之下，交集 >0，保证锚点直达后当前章节必高亮）
    const BAND_TOP_PX = 72;
    const BAND_BOTTOM_MARGIN_RATIO = 0.6;
    const observer = new IntersectionObserver(
      (entries) => {
        const intersecting = entries.filter((entry) => entry.isIntersecting);
        if (intersecting.length === 0) return;
        // 瞬跳（prefers-reduced-motion、Find 跳转、程序化 scrollTo）时，上一章节可能
        // 只剩底边搭在带顶（top < 带顶仍算相交），与落点章节同批派发；「顶边已进带」
        // 的章节才是读者落点，优先于只剩尾部擦带的章节。无顶边在带内时退回全体相交项
        // （超高章节横跨整条带、或向上回滚时上一章节从带顶重新进入的情形）。
        const bandBottom = window.innerHeight * (1 - BAND_BOTTOM_MARGIN_RATIO);
        const arriving = intersecting.filter((entry) => {
          const top = entry.boundingClientRect.top;
          return top >= BAND_TOP_PX && top <= bandBottom;
        });
        const candidates = arriving.length > 0 ? arriving : intersecting;
        // 判定带内可能同时容下多个短章节（如技能标签列表），取「顶部最靠上」的作为当前章节
        const topmost = candidates.reduce((best, entry) =>
          entry.boundingClientRect.top < best.boundingClientRect.top ? entry : best,
        );
        setActiveId((topmost.target as HTMLElement).id);
      },
      {
        rootMargin: `-${BAND_TOP_PX}px 0px -${BAND_BOTTOM_MARGIN_RATIO * 100}% 0px`,
        threshold: 0,
      },
    );
    sections.forEach((section) => observer.observe(section));
    observerRef.current = observer;
    return () => observer.disconnect();
  }, [items]);

  if (items.length === 0) return null;

  return (
    <>
      <nav className="report-toc" aria-label={ariaLabel} data-hydrated={hydrated ? 'true' : undefined}>
        <ul>
          {items.map((item) => (
            <li key={item.id}>
              <a
                href={`#${item.id}`}
                className={activeId === item.id ? 'is-active' : undefined}
                aria-current={activeId === item.id ? 'true' : undefined}
                onClick={() => setActiveId(item.id)}
              >
                {item.label}
              </a>
            </li>
          ))}
        </ul>
      </nav>
      {backToTopLabel && (
        <button
          type="button"
          className="back-to-top"
          onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
        >
          {backToTopLabel}
        </button>
      )}
    </>
  );
}
