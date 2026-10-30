# 设计 · 可分享证明卡（Share Proof Card）

- 状态：**现行（2026-10-30）**
- 决策：**#29 已拍板（2026-10-30，用户授权「那你搞」，采纳助手建议方案）**
- 一句话：把报告页里最强的资产（真实性分级 + 技能标签 + 可复核证据链）做成**可传播的「证明物」**——补上「内容最强但没有传播形态」这一环。
- 触发背景：[市场与竞品更新-20261003](市场与竞品更新-20261003.md) P1 防御项（GitHub Skills 抢「技能徽章」心智、GotSkillz/Checkmarked 全是作品集传播形态）+ 生产流量瓶颈（complete 画像 5、funnel 事件 13）。[竞争定位](design-competitive-positioning-20261008.md) 杠杆 1「能力证明层」叙事的落地物。
- 与既有文档关系：漏斗埋点见 [design-funnel-analytics-20261015](design-funnel-analytics-20261015.md)（share_clicked 已存在，复用）；i18n 见 [design-i18n-20260910](design-i18n-20260910.md)；token 见 [design-tokens-20260910](design-tokens-20260910.md)。

## 1. 范围（P0，本期）

### 1.1 报告页 OG meta（分享到微信/X/LinkedIn 的门面）

- [Layout.astro](../apps/report/src/layouts/Layout.astro) 增加可选 og props，其他页面零影响。
- 报告页传入：`og:title`＝`{login} · {真实性标签}`；`og:description`＝headline + Top 技能 + 「每条结论可点击复核」；`og:url`＝shareUrl；`og:image`＝**静态品牌卡** `/og-card.png`（1200×630，绝对地址）；`twitter:card=summary_large_image`。
- 动态 per-profile og:image（把用户数据画进图）需要服务端光栅化（satori/CJK 字体 ≥10MB）——**P1 观察 OG 曝光后再议**，本期用静态品牌卡 + 动态 title/description 拿到 90% 价值。

### 1.2 静态品牌卡资产

- `apps/report/public/og-card.png`：1200×630，品牌卡（JobAgent 字标 + 「Verifiable developer profiles」英文一句 + 品牌绿 #16a34a 几何元素）。
- 生成脚本 `tools/gen-og-card.mjs`：Playwright chromium 渲染 SVG → 截图 PNG（仓库已依赖 Playwright，零新增依赖；**卡面只用英文**，规避 headless CJK 字体不确定性）；色值取自 ui-tokens（脚本内注释标明来源）。

### 1.3 页面「能力证明卡」+ 下载 PNG

- 新 React island `ProofCard.tsx`：渲染紧凑预览卡（品牌行 / 主体 login@platform / 真实性徽章（复用 `ja-badge--*` 四态类）+ 置信度 / Top 技能 ≤6 / 生成日期 + 域名 + 「每条结论可点击复核」）。
- 「下载 PNG」：客户端 canvas 按 1200×630 重绘同一信息层级 → `toBlob` 下载 `jobagent-proof-{login}.png`。颜色经 `getComputedStyle` 读实际渲染元素上的 `--ja-*` 变量，**代码零 hex**（token 守护纪律）；深浅色主题自动跟随。
- 下载成功后 fire-and-forget `POST /funnel/events {event:'share_clicked'}`（与 [ShareButton](../apps/report/src/components/ShareButton.tsx) 同口径，`credentials:'include'`，失败静默）。
- 摆位：报告页头部操作区之后、摘要卡之前；**不进 TOC**（是分享工具，不是报告章节）。

### 1.4 卡面信息层级（只渲染快照已有结论）

品牌名 → 主体 `login · platform` → 真实性标签 + 置信度% → 技能标签 ≤6（`skillTags` 已排好序取前 6）→ `generatedAt` + 域名 → 「每条结论可点击复核」。

## 2. 明确不做

- **不放照片、邮箱、联系方式、外部社交链接**（防滥用与骚扰；报告页公开口径本就不含）。
- 不做动态 per-profile 服务端 OG 图（P1 视 OG 曝光数据再议）。
- 不做「一键分享到某平台」（不代用户发社交内容；复制/下载后怎么用由用户决定）。
- 不给未认领画像加任何「官方认证」暗示——证明卡标题就是能力画像，认领态徽标维持报告页现状。
- 不改 API/契约/迁移，零后端改动。

## 3. i18n

用户可见文案走 `t()`：新增 `report.proof.*` 键（zh 先行、en 同构对齐，守护测试覆盖）。卡面技能名为技术术语（数据层英文原文），不翻译。

## 4. 测试

- `ProofCard.test.tsx`：信息层级渲染（主体/徽章/标签数 ≤6/页脚复核句）；下载路径 mock canvas（jsdom `getContext` 返回 null 需守卫）断言 funnel 上报与文件名。
- 报告 E2E 补一条 og meta 断言（`og:title` 存在且含 login）。
- 门禁：report 单测 / typecheck / build / `git diff --check`。

## 5. 验收

1. 报告页源码含 og/twitter meta，`og:title` 带主体与真实性标签。
2. 「下载 PNG」产出 1200×630 图片，深浅色主题下配色正确、无 hex 散落。
3. 下载动作产生 `share_clicked` 漏斗事件（fail-open）。
4. 其他页面（首页/工作台等）head 无 og 标签回归。
