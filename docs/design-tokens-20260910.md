# JobAgent 设计 token 设计（CSS 变量体系）

> 状态：**现行**；日期：2026-09-10；适用范围：**本仓库 `job-agent`（报告页 / 主应用）**。
> 依据：[AGENTS.md 设计 token 硬约束](../AGENTS.md)、[PRD NFR-8](PRD.md)（海内外同步，视觉同样要两套语言下一致）。
> 与 i18n 配套落地：[design-i18n-20260910.md](design-i18n-20260910.md)。

## 1. 目标与非目标

**目标**

1. 颜色 / 间距 / 圆角 / 阴影 / 字号**单一事实源**，改一处即全站生效。
2. 组件里**看不到**具体数值：不出现 `#hex`、`rgb()`、`hsl()` 与硬编码尺寸。
3. 后续接暗色模式、换品牌色、两区域一致视觉时，只改 token 层。

**非目标**

- 落地页 `job-agent-landing` 自有 `--lui-*` 变量体系**不在本仓约束内**，由项目负责人自行推进；本仓不复制、不强制统一（统一事项见 [deferred-items.md](deferred-items.md)）。
- 不引入 CSS-in-JS / Tailwind 主题配置 / 组件库主题系统（MVP 用纯 CSS 变量，Astro 与 React islands 共用）。
- 不做设计系统文档站、不做 Figma 变量同步。

## 2. 分层

| 层 | 命名 | 组件可用 | 说明 |
| --- | --- | --- | --- |
| Primitive（原始） | `--ja-color-green-600`、`--ja-space-4` | ❌ 禁止 | 原始色板与刻度，只被 semantic 层引用 |
| Semantic（语义） | `--ja-color-accent`、`--ja-color-surface` | ✅ 只允许这一层 | 表达用途；换主题只改这一层映射 |
| Component（可选） | `--ja-card-padding` | ✅ | 仅当同一组合出现 3 次以上才提取 |

## 3. 命名与首版清单

前缀统一 `--ja-`，分类用中划线：

```css
:root {
  /* color —— semantic */
  --ja-color-bg; --ja-color-surface; --ja-color-surface-muted;
  --ja-color-fg; --ja-color-fg-muted; --ja-color-border;
  --ja-color-accent; --ja-color-accent-hover; --ja-color-accent-fg;
  --ja-color-success; --ja-color-warning; --ja-color-danger;
  /* 真实性分级四态（与 analyzer-core 枚举一一对应） */
  --ja-color-auth-likely; --ja-color-auth-mixed; --ja-color-auth-suspicious; --ja-color-auth-insufficient;

  /* space —— 4px 基准刻度 */
  --ja-space-1 … --ja-space-6;   /* 4 / 8 / 12 / 16 / 24 / 32 */

  /* radius / shadow */
  --ja-radius-sm; --ja-radius-md; --ja-radius-lg;
  --ja-shadow-card;

  /* typography */
  --ja-font-sans; --ja-text-sm; --ja-text-base; --ja-text-lg; --ja-leading-normal;
}
```

- 颜色语义名**只描述用途**（`surface` / `fg-muted`），不描述色相（禁止 `--ja-green`）。
- 真实性四态的颜色必须与 `analyzer-core` 的 `authenticity.status` 枚举一一对应，新增枚举时同步加 token。

## 4. 放置与加载

- 定义文件：`apps/report/src/styles/tokens.css`；在 Astro 布局（`src/layouts/Layout.astro`）中全局引入一次。
- 暗色模式：`:root[data-theme='dark']`（或 `prefers-color-scheme`）**只覆盖 semantic 层**，primitive 层不动。
- 未来若有第二个前端工程，token 文件移入共享包并从本文件 re-export，组件写法不变。

## 5. 硬规则

1. 组件样式只写 `var(--ja-xxx)`；**禁止** `#hex`、`rgb()`、`hsl()`、硬编码 `px` 尺寸（间距/圆角/字号走 token；0 与 1px 边框等结构性例外需注释说明）。
2. **禁止**带 hex 兜底的写法 `var(--ja-color-accent, #16a34a)`——兜底会掩盖 token 缺失。
3. primitive 层只允许被 semantic 层引用，组件不得跨层取值。
4. 主题切换通过切换 `data-theme` 或重新定义 semantic 层，不在组件里做条件判断。

## 6. 校验与验收

- **校验**：MVP 用一个单测（或只读脚本）扫描 `apps/report/src` 下 `.astro/.tsx/.css`，断言除 `tokens.css` 外不出现 hex 颜色字面量；后期如需更强约束再考虑 Stylelint（见 deferred）。
- **验收**：
  1. 报告页首屏所有颜色/间距/圆角/字号均来自 token；
  2. 改 `--ja-color-accent` 一个值，全站强调色随之变化；
  3. 中英两种语言下版式不破（同一 token 体系下不应出现语言相关的样式分叉）。

## 7. 待确认（未拍板，不得当已决策实现）

- 首版色板取值（当前落地页 `--lui-*` 的绿色系可作为参考，但不直接照搬，需确认品牌色）。
- 是否需要暗色模式进入 P0——建议 P0 先只做浅色并预留 `data-theme` 结构，待报告页上线后按用户反馈决定。
