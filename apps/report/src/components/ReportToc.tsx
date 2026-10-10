/**
 * 报告页右侧章节锚点导航（design-ui-polish-20261010.md V3）。
 *
 * - 纯展示 + 滚动高亮：IntersectionObserver 观察各章节 id，进入视口顶部区域的章节高亮；
 * - 点击锚点走原生 href 平滑滚动（CSS scroll-behavior: smooth + 章节 scroll-margin-top）；
 * - <960px 由 CSS 隐藏（report-page.css，与 --ja-breakpoint-lg 对齐）。
 *
 * 用户可见文案（aria-label）由 Astro 侧经 t() 传入，组件内不硬编码。
 */
import { useEffect, useRef, useState } from 'react';

export interface ReportTocItem {
  id: string;
  label: string;
}

interface Props {
  items: ReportTocItem[];
  ariaLabel: string;
}

export default function ReportToc({ items, ariaLabel }: Props) {
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

    // 视口顶部 40% 为「当前章节」判定带；顶部 -72px 与章节 scroll-margin-top:88px 错开
    // （88px 停在判定带 72px 起点之下，交集 >0，保证锚点直达后当前章节必高亮）
    const observer = new IntersectionObserver(
      (entries) => {
        const intersecting = entries.filter((entry) => entry.isIntersecting);
        if (intersecting.length === 0) return;
        // 判定带内可能同时容下多个短章节（如技能标签列表），取「顶部最靠上」的作为当前章节
        const topmost = intersecting.reduce((best, entry) =>
          entry.boundingClientRect.top < best.boundingClientRect.top ? entry : best,
        );
        setActiveId((topmost.target as HTMLElement).id);
      },
      { rootMargin: '-72px 0px -60% 0px', threshold: 0 },
    );
    sections.forEach((section) => observer.observe(section));
    observerRef.current = observer;
    return () => observer.disconnect();
  }, [items]);

  if (items.length === 0) return null;

  return (
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
  );
}
