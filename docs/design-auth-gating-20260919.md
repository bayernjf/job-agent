# 设计：账号收尾两刀 —— OAuth `return_to` 深链回跳 + 报告页授权分级闸

> 状态：**已落地（2026-09-19，item31 / item32）**
> 范围：API（Hono）+ 报告页（Astro SSR）+ 共享 Cookie 常量 + 单测 / E2E + 文档
> 关联：[API.md §1.2](API.md)、[design-demo-mode-20260915](design-demo-mode-20260915.md)（三态 Principal）、handoff item28–32、[deferred-items](deferred-items.md)
> 前置：账号授权主脊（GitHub OAuth 登录 / 会话 / 本人认领，item28–30）已落地并在本地真实打通。

## 1. 背景与目标

账号主脊打通后遗留两个体验/边界缺口：

1. **登录后总是回首页**：用户从某个报告深链（尤其招聘方核验视图 `?view=recruiter`）被引导去 GitHub 登录，登录成功后固定跳到 `AUTH_AFTER_LOGIN_URL`（默认 `/`），丢掉了原本要看的页面。
2. **完整核验内容对匿名访客完全敞开**：报告页招聘方视图的原始证据外链、面试题、面试准备包 Markdown，任何人拼 URL（`?view=recruiter`）即可全量获取，缺少"登录转化"与"轻量防搬运"门槛。

两刀都**不改变画像数据的公开属性**（画像来自公开行为痕迹），只控制"高价值、可被直接搬运的核验层"的呈现，并保证登录流程能回到用户出发的页面。

## 2. 第一刀：OAuth `return_to` 深链回跳

### 2.1 威胁模型：开放重定向（open redirect）

登录回跳若直接信任用户传入的 URL，攻击者可构造
`/auth/github/login?return_to=https://evil.com`，用户在真实站点完成 GitHub 登录后被跳到钓鱼站（携带"刚完成授权"的信任心理）。因此回跳目标必须被约束为**本站同源相对路径**。

### 2.2 纯函数白名单 `sanitizeReturnTo`

单一事实源 `apps/api/src/auth-return-to.ts`，纯函数、无 I/O、可穷举单测：

- 仅接受以**单个 `/` 开头**的绝对路径（拒绝 `https://…`、`javascript:…`、无前导斜杠的相对路径）。
- 第二字符不得是 `/` 或 `\`：拦截协议相对 URL `//host/path` 与 `/\host/path`（浏览器会把 `//host` 解析为跳到 host 的绝对 URL）。
- 拒绝任何控制字符（`\u0000–\u001f`、`\u007f`，含 CR/LF/Tab），防响应头注入与怪异 URL 解析。
- 长度上限 `MAX_RETURN_TO_LENGTH = 2048`。
- 拒绝回 `/auth/` 前缀（含 login/callback），避免登录环；形似但不同目录的 `/authoring` 之类仍放行。
- 先 `trim()`；非法 / 缺失 / 空值一律返回 `null`，由调用方回退默认落地页。

### 2.3 Cookie 流转与时序

- 不把 `return_to` 放进 GitHub OAuth `state`（state 只承担 CSRF 签名职责，且会出现在与 GitHub 的往返里），也**不落访问日志**。
- `GET /auth/github/login?return_to=…`：首次 `sanitizeReturnTo` 校验通过后，写入短期 HttpOnly Cookie `jobagent_oauth_return`（常量 `AUTH_RETURN_COOKIE`，`Path=/auth/github; HttpOnly; SameSite=Lax; Max-Age=600`，生产 HTTPS 加 `Secure`），与 state Cookie 同生命周期、同路径作用域。
- `GET /auth/github/callback`：在 state 校验、换 token、upsert 账号、建会话、下发 `jobagent_session` 成功后，读回该 Cookie 并**再次 `sanitizeReturnTo`**（Cookie 值是客户端可改的，不能假设它已被校验），通过则 `302` 回深链，否则回 `AUTH_AFTER_LOGIN_URL`；无论是否存在，最后都 `deleteCookie` 清除（用完即删，不残留）。
- 报告页 / AccountMenu 拼登录链接时统一传
  `${apiBase}/auth/github/login?return_to=${encodeURIComponent(pathname + search)}`，招聘方视图保留 `?view=recruiter`。

### 2.4 时序

```text
报告页(未登录,点登录)
  → GET /auth/github/login?return_to=/zh-CN/report/p?view=recruiter
       种 state Cookie + return Cookie → 302 GitHub
  → 用户在 GitHub 授权
  → GET /auth/github/callback?code&state
       校验 state → 换 token → upsert 账号 → 建会话种 session Cookie
       → 二次校验 return Cookie → 302 回 /zh-CN/report/p?view=recruiter（删 state/return Cookie）
```

## 3. 第二刀：报告页授权分级闸

### 3.1 两档模型（不做三级）

| 档位 | 身份 | 可见性 |
| --- | --- | --- |
| 未登录 | `anonymous`、`demo`（演示会话） | 公开门面（见 3.2 矩阵） |
| 登录 | `user`（本人 + 登录的招聘方，**可见性相同**） | 全部内容；本人额外只有"认领"能力 |

不区分"本人 vs 登录的招聘方"：画像本质是公开行为证据，登录门槛的目的是转化与轻量防搬运，不是做访问控制名单；本人相对其他登录用户的**唯一**额外动作是 claim 认领（item28/29 已有）。

### 3.2 可见性矩阵

| 报告内容 | 未登录 | 登录 user |
| --- | --- | --- |
| 头部 / 摘要 / 真实性分级与置信度 / 信号 label·detail / 技能标签名与深度 / 活跃协作聚合 / caveats / 盲区 | 可见 | 可见 |
| 岗位推荐、岗位定向简历 builder、投递追踪 | 可见 | 可见 |
| 岗位匹配卡片及其**匹配理由证据**（决策 #10 要求匹配理由可回溯） | 可见 | 可见 |
| 招聘方核验视图（`?view=recruiter`）三处**原始证据外链**（真实性信号 / 技能 / 面试题依据） | 折叠为登录墙 | 可见 |
| 面试题题目与考察意图 | 折叠为「题数 + 登录墙」 | 可见 |
| 面试准备包 Markdown 下载（`GET /[locale]/report/:id/interview-kit.md`） | 隐藏下载链接，端点 `401` | `200` 下载 |
| 联系方式（email/电话） | N/A：画像契约本就不含，本地补填只在浏览器 | N/A |

设计取向：**结论公开、证据原文登录可见**。访客仍能看到"该候选人真实性分级、技能、匹配度"等结论性价值（利于传播与 SEO），但"逐条可点击的原始 PR/Issue 链接 + 可直接搬走的面试题库 + 可导出的面试包"需要登录，形成招聘方转化点，也抬高批量搬运门槛。

### 3.3 SSR 身份解析

报告页是 **Astro SSR 直读只读 storage（不走 API 服务）**，故身份解析与折叠都在 SSR 层：

- `apps/report/src/lib/auth.ts` 导出 `resolveViewer(cookieHeader, deps?)` 与 `canViewGatedContent(viewer)`：
  - 读 `jobagent_session` → 只读 storage 的 `authSessions.getActive(token, now)` → `accounts.getById`，得到 `{kind:'user', platform, login, claimedProfileId}`。
  - 无 Cookie / 坏 Cookie / 过期或已撤销会话 / 账号缺失 / 只读查询异常，一律静默降级 `{kind:'anonymous'}`——**fail-open 的是"登录墙"而非数据**：降级只会让访客多看一张登录卡，不会泄露任何非公开内容。
  - **只读、绝不调用 `authSessions.touch()`**（写操作，会在只读连接上报错，也避免浏览即续期）。
- `demo` 在报告页不单独成档：演示会话只用于"触发新分析"的配额闸（API 侧），分级闸只问"是不是登录 user"。

### 3.4 呈现与端点

- 新增纯 SSR 组件 `apps/report/src/components/GateCard.astro`（无 JS 依赖）：标题 + 说明 + GitHub 登录按钮（带 `return_to`），`data-testid="gate-card/gate-login"`，样式全用 `--ja-*` token。
- 报告页 `[profileId].astro`：
  - 招聘方视图未登录：原说明 banner 位置换为证据 `GateCard`（`testid="evidence-gate"`），三处证据外链的渲染条件由 `isRecruiter` 收紧为 `isRecruiter && canViewGated`；view-toggle 仍保留（未登录也能切到招聘方视角看到墙）。
  - 面试题模块未登录：整块替换为面试 `GateCard`（`testid="interview-gate"`），文案带题数 `{count}`，不渲染题目正文与下载链接；登录后维持原样。
- 端点 `interview-kit.md.ts`：开头 `resolveViewer`，非 user 直接 `401 text/plain`（UI 上匿名看不到下载链接，正常用户不会撞上；直接拼 URL 的抓取被挡）。
- `AccountMenu.tsx`：匿名登录链接携带 `window.location.pathname+search` 的 `return_to`。
- i18n：新增 `report.gate.evidenceTitle/evidenceBody/interviewTitle/interviewBody/loginButton` 共 5 key，中英 JSON 同构（key 对齐由既有一致性测试守护，落地后 236/236 对齐）。

## 4. 明确不做（边界与缓做）

- **JSON API 字段级裁剪不在本刀**：`GET /profiles/:id` 与 `/profiles/:id/exportable` 保持公开。理由：浏览器扩展一键填充依赖 exportable，且其投影本身不含证据 URL、不含面试题；未登录 API 面本就基本拿不到证据 URL（exportable 无；snapshot 内只有 evidenceId 无 URL；仅 job-recommendations 返回匹配理由相关的少量证据，而决策 #10 要求其可回溯）。若未来对外公开分享后出现 API 批量抓取/搬运滥用，再对 snapshot 做字段级裁剪（连面试题文本也裁），已登记 [deferred-items](deferred-items.md)「JSON API 字段级授权裁剪」。
- 不做三级可见性、不做招聘方白名单/名单审核、不做联系方式门控（契约无此字段）。
- 不改 analyzer-core / 不把身份逻辑拖进分析内核（内核保持源无关、无 I/O）。

## 5. 测试与验证

- **纯函数单测**：`auth-return-to.test.ts` 8 例（合法路径/trim/空值/协议相对/绝对 URL 与 scheme/控制字符/超长边界//auth 回环）。
- **API 集成**：`auth-flow.test.ts` 新增 "OAuth return_to deep link" 3 例（同源回跳且清 Cookie、协议相对被拒回退 `/`、无 return_to 回退 `/`）。
- **报告 SSR 单测**：`apps/report/src/lib/auth.test.ts` 5 例（内存 SQLite：无 Cookie/过期/未知会话→anonymous、有效会话→user、门控判定）。
- **报告 E2E**：新增 `e2e/gated-content.spec.ts` 6 例（匿名三例：面试题墙含题数与 return_to、招聘方证据墙、kit 端点 401；登录三例：题目与下载可见、证据外链+banner、kit 端点 200）。global-setup 补 seed 本人账号 + 固定未过期会话 + 一条可点击外部 PR 证据。
- 同步修正受分级闸影响的既有断言：`recruiter-features.spec.ts`（招聘方视图两例改为登录态）、`account-auth.spec.ts`（登录 href 带 return_to）、`report-render.spec.ts`（匿名面试题断言改为登录墙）。
- 全仓 `pnpm -r typecheck` 全 Done、`pnpm -r test` 全过、`pnpm --filter @jobagent/report build` 通过、报告 E2E 全绿、`git diff --check` 干净。

## 6. 落地记录（2026-09-19）

| 提交 | 内容 |
| --- | --- |
| `ba21d04` `feat(api)` | `sanitizeReturnTo` 纯函数 + 单测；shared `AUTH_RETURN_COOKIE`；login 种 return Cookie、callback 二次校验回跳并清除；auth-flow 3 端点测试 |
| `4600a87` `feat(report)` | SSR `resolveViewer`/`canViewGatedContent` + 单测、`GateCard.astro`、报告页三处证据与面试题门控、interview-kit 端点 401、AccountMenu 带 return_to、5 组中英 i18n key、gated-content E2E 6 例与三处既有断言修正 |
| 本 docs 提交 | 本设计文档 + API.md §1.2 + deferred-items + handoff/docs README 回写 |

验证数据（Node v24.0.0）：apps/api 122 测试全过（含 return_to 11 中相关）、apps/report 33 单测全过（含新增 auth 5）；受影响 4 个 E2E spec 22/22 通过；全仓 typecheck/test exit 0。作者保留为仓库 owner，未加 AI co-author；**未 push**（push 与 dev→main PR 由负责人执行）。
