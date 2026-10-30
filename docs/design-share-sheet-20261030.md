# 设计 · 分享菜单（Share Sheet，决策 #30）

- 状态：**现行（2026-10-30）**
- 决策：**#30 已拍板（2026-10-30，用户明确需求「分享自己的画像到社交平台」+「搞合规的」）**
- 一句话：把报告页「复制链接」升级为分享菜单——**只走平台官方分享入口 + Web Share API**，发布动作永远由用户本人在平台页面完成。
- 与 #29 的关系：#29 边界「不做一键分享到某平台」针对的是**代发**；#30 细化边界——官方 intent 入口合规可用（用户仍亲手按发布），**API 代发与自动化用户会话永久禁止**。

## 1. 合规边界（功能的成立前提）

| 形态 | 合规 | 依据 |
| --- | --- | --- |
| 官方 intent URL（新窗口打开平台分享页，预填链接+文案） | ✅ | 平台自身提供的无鉴权标准入口（X web intent、LinkedIn `sharing/share-offsite`、Reddit `submit`、Telegram `share/url`、微博 `service.weibo.com/share`）；发布动作在平台页面上由用户本人完成，不涉及任何账号授权 |
| Web Share API（`navigator.share` 系统分享面板） | ✅ | 浏览器标准能力，目标平台由用户在系统面板自选 |
| 微信 | ✅（形态不同） | 无 web intent；链接粘贴进会话由 OG 卡片承担展示（#29 成果），菜单里只放提示文案 |
| 平台 API 代发 / 自动化用户已登录会话 | ❌ 永久禁止 | LinkedIn 发帖 scope 合作审批制；X API 付费档 + 自动化标注；自动化会话违反 ToS 且封的是用户账号 |

红线：**绝不代发**——预填文案只放中性一句 + 链接，展示力交给 OG 卡片。

## 2. 交互（ShareButton island 原地升级）

- 触发按钮维持现有「分享」样式与位置（头部操作区）；点击展开下拉菜单（`aria-expanded`、Escape/点击外部关闭）。
- 菜单项（浏览器支持 `navigator.share` 时才显示系统分享项）：
  1. 复制链接（原行为，保留 copied 反馈）
  2. 系统分享（`navigator.share({ title, text, url })`；用户取消＝AbortError 静默）
  3. 分享到 X / LinkedIn / Reddit / Telegram / 微博（`window.open` 官方入口，`noopener noreferrer`）
  4. 微信提示行（纯文案，不可点）
- 预填文案：SSR 现拼（`{login} 的可核验能力画像 · 每条结论可点击复核`），组件不写自然语言；LinkedIn 只收 url（卡片由 OG 提供）。
- 漏斗：菜单内任何分享动作（复制/系统分享/任一平台）都 fire-and-forget `share_clicked`（credentials 必带，失败静默）——与原口径一致。

## 3. 明确不做

- 不接任何平台 OAuth/发帖 API；不做定时/批量代发；不读用户社交平台数据。
- 不做二维码（贴简历/线下场景 P1 再议，避免新依赖）。
- 不预填夸大文案、不代写帖子正文。

## 4. 测试

- 组件：菜单开合与 aria-expanded、复制路径回归、平台点击断言 `window.open` 的 intent URL 编码与参数、系统分享断言 `navigator.share` 调用、无 `navigator.share` 时菜单项隐藏、全部动作上报 `share_clicked`。
- 门禁：report 单测 / typecheck / eslint / report E2E（现有用例不依赖分享按钮，回归即可）。
