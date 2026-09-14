# JobAgent 设计 token 设计（CSS 变量体系）

> 状态：**现行**；日期：2026-09-10（2026-09-14 增补第 8 节：覆盖浏览器扩展、token 上移共享包）；适用范围：**本仓库 `job-agent` 全部前端界面——报告页 `apps/report` 与浏览器扩展 `apps/extension`**。
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
- **第二个前端已出现（2026-09-14）**：token 单一事实源已上移到无构建静态包 `packages/ui-tokens/tokens.css`，报告页本文件改为 `@import '@jobagent/ui-tokens/tokens.css'` re-export，组件写法不变；扩展侧落地见第 8 节。

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

## 8. 浏览器扩展（apps/extension）落地（2026-09-14 增补，已实施）

扩展是第二个前端工程，触发本节；它与报告页的关键差异是 **UI 挂在 Shadow DOM 里、注入到任意第三方 ATS 页面**，因此报告页「全局 `:root` 一次加载」的前提不成立，方案如下。

### 8.1 单一事实源上移到 `packages/ui-tokens`

- 新增**无构建静态包** `packages/ui-tokens/tokens.css`：primitive/semantic/dark 三层定义的唯一来源；`packages/ui-tokens/package.json` 通过 `exports"./tokens.css"` 对外暴露，不产出 JS。
- 报告页 `apps/report/src/styles/tokens.css` 只保留 `@import '@jobagent/ui-tokens/tokens.css'`（Vite/Astro 构建期内联，组件与既有写法零改动）。
- 扩展在 `build.mjs` 把该文件拷到 `dist/tokens.css`，content script 创建 shadow root 后**先挂 tokens 样式表、再挂 panel.css**（MV3 content script 不能用 ES module，走与 panel.css 相同的 `chrome.runtime.getURL` + `<link>` 注入方式）。

### 8.2 Shadow DOM 作用域：`:root, :host` 双选择器

- 页面文档的 `:root`（html）变量**不会自动进入第三方页面的 shadow 树**，宿主 ATS 页面也不可能定义 `--ja-*`；扩展 shadow 内的样式表中 `:root` 选择器又匹配不到 shadow 内容。
- 因此共享 token 的每层定义选择器写成 **`:root, :host`**：普通页面里 `:root` 命中 `<html>`、`:host` 不命中（无副作用）；扩展 shadow 样式表里 `:host` 命中挂载宿主、变量经继承覆盖整个 shadow 树。暗色同理：`:root[data-theme='dark'], :host([data-theme='dark'])`。
- **严禁**依赖宿主页面任何样式；宿主容器 `all: initial` 隔离不变。

### 8.3 扩展侧使用与组件级 token

- `panel.css` 只允许出现 `var(--ja-*)`；扩展主色从原先自写的蓝色 `#2d6cdf` 统一到语义 `--ja-color-accent`（品牌绿），状态块用新增的语义 token `--ja-color-success-bg/-fg`、`--ja-color-danger-bg/-border/-fg`（已在共享包补齐 primitive 与暗色映射）。
- 面板固定宽度、悬浮球尺寸这类**单一组件结构尺寸**，按第 2 层 Component 约定就近定义在 `panel.css` 的 `:host {}`（如 `--ja-panel-width`），不进共享包；`1px` 边框、`999px` 胶囊、首帧定位锚点等结构性字面量保留并加注释。
- 扩展 P0 只做浅色（与第 7 节一致），但因 token 来自共享包，暗色结构已免费预留。

### 8.4 校验

- 扩展新增 `src/styles/tokens-guard.test.ts`：扫描 `panel.css` / `panel.tsx` / `content/index.tsx`，除共享 token 源文件外**不得出现 hex 颜色字面量与 `rgb()/rgba()/hsl()`**（结构性 px 尺寸不在此扫描内，由 review 按 8.3 约束）。
- 报告页既有视觉不得回退：改完以 `pnpm --filter @jobagent/report build` 验证共享 token 被正确内联打包。
