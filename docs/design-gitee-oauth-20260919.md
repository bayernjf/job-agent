# 设计：Gitee 平台 OAuth 登录与本人画像认领

> 状态：**已落地（2026-09-19，item33）**
> 范围：API（Hono）+ 报告页（Astro SSR / React island）+ 配置 / env + 单测 / E2E + 文档
> 关联：[API.md §1.2](API.md)、[design-auth-gating-20260919](design-auth-gating-20260919.md)（return_to 深链 + 授权分级闸）、[design-gitee-source-20260914](design-gitee-source-20260914.md)（Gitee 采集源）、handoff item28–32、[deferred-items](deferred-items.md)
> 前置：账号授权主脊（GitHub OAuth 登录 / 会话 / 本人认领，item28–32）与 Gitee 采集源（双源分析）均已落地。

## 1. 背景与目标

双源（GitHub + Gitee）采集与跨源融合上线后，系统已经能产出 **Gitee 主体**的能力画像，`accounts.platform` 与 `profiles.subject_platform` 也从第一天就预留了 `gitee` 枚举，claim 认领按 `(platform, login)` 比对。但**登录入口只有 GitHub OAuth**：一个纯 Gitee 用户无法登录，也就无法认领本人的 Gitee 画像，授权分级闸对 Gitee 画像的"登录解锁"同样断链。

本设计**对称复用**既有 GitHub OAuth 主脊，新增 Gitee 为第二个 `AuthProvider`，不改动会话、认领、授权闸的内核逻辑：

- 新增 `GiteeAuthProvider`（实现既有 `AuthProvider` 端口）与 `/auth/gitee/login`、`/auth/gitee/callback` 两条路由。
- 新增 `GITEE_OAUTH_CLIENT_ID` / `GITEE_OAUTH_CLIENT_SECRET` 环境变量；未配置时 Gitee 登录路由返回 `501 AUTH_NOT_CONFIGURED`，与 GitHub 行为一致。
- 报告页头部登录菜单按后端"已配置的登录方式"动态渲染 GitHub / Gitee 按钮；授权分级闸（GateCard）按**画像主体平台**给出对应平台的登录按钮。
- Gitee 用户登录后，`principal.platform='gitee'`，认领本人 Gitee 画像的既有 claim 逻辑**直接成立，无需改动**。

非目标（本期不做）：账号绑定/合并（同一人同时绑定 GitHub + Gitee）、Gitee OAuth 的 refresh token 持久化与续期、真实 Gitee OAuth App 凭证（属外部部署项，见 §9）。

## 2. Gitee OAuth2 授权码流程（协议事实）

Gitee 使用标准 OAuth2 authorization-code flow，三步与 GitHub 同构，但请求细节有三处差异。

| 步骤 | 方法 & URL | 关键参数 |
| --- | --- | --- |
| 1. 授权页 | `GET https://gitee.com/oauth/authorize` | `client_id`、`redirect_uri`、`response_type=code`（**必传**）、`state`、`scope`（本期 `user_info`） |
| 2. 换 token | `POST https://gitee.com/oauth/token` | body（`application/x-www-form-urlencoded`）：`grant_type=authorization_code`（**必传**）、`code`、`client_id`、`client_secret`、`redirect_uri` |
| 3. 取用户 | `GET https://gitee.com/api/v5/user?access_token=<token>` | Gitee v5 惯例把 access_token 放 **query 参数**；返回当前用户 |

- 步骤 2 成功响应为 JSON：`access_token`、`token_type="bearer"`、`expires_in`（秒，常见 86400）、`refresh_token`、`scope="user_info"`、`created_at`。
- 步骤 3 返回体关键字段（snake_case）：`id`（**number**）、`login`（登录名）、`name`（展示名，可空）、`email`（公开邮箱，可能为 `null`）、`avatar_url`（头像）。
- `scope=user_info` 即"获取用户信息"，是登录所需最小权限；本期不申请仓库/邮件写权限。

### 2.1 与 GitHub OAuth 的三处差异（实现必须对齐）

1. **授权请求必须显式带 `response_type=code`**（GitHub 的 `/login/oauth/authorize` 同样用 code，但 Gitee 对该参数是必填校验）。
2. **token 交换 body 必须带 `grant_type=authorization_code`**；GitHub 的 token 端点以 client 约定隐含授权码类型，Gitee 要求显式声明。
3. **取用户用 `?access_token=` query 参数**（Gitee v5 OpenAPI 的通用惯例），而非 GitHub 的 `Authorization: Bearer` 头。为稳妥与官方示例一致，本期 Gitee provider 采用 query 传 token；token 仅出现在服务端到 Gitee 的单次 HTTPS 请求中，不下发前端、不入日志。

> 参考来源（端点/参数经多源交叉一致）：Gitee 官方 OAuth 文档 <https://gitee.com/api/v5/oauth_doc>、v5 用户接口 Swagger <https://gitee.com/api/v5/swagger#/getV5User>；第三方实现核对：腾讯云开发者社区《手把手带你实现第三方应用登录》（token 响应字段）、CSDN 多篇 Spring 集成（`authorization-uri=https://gitee.com/oauth/authorize`、`token-uri=https://gitee.com/oauth/token`、`user-info-uri=https://gitee.com/api/v5/user`、`grant_type=authorization_code`、`scope=user_info`、`/api/v5/user?access_token=`）。官方 OAuth 文档页为前端渲染，正文无法静态抓取；**真实联调时以官方文档与实际响应为准**（测试一律用 fake provider / 录制夹具，不打网络）。

## 3. 后端设计

### 3.1 配置 `auth-config.ts`

`AuthConfig` 在既有 `github` 段旁对称新增 `gitee` 段，会话 TTL、state 密钥、回调基址、登录后落地页、生产标志等**两平台共用**：

```ts
gitee: { clientId: string; clientSecret: string; configured: boolean }
```

`loadAuthConfig(env)` 读取：

- `GITEE_OAUTH_CLIENT_ID`
- `GITEE_OAUTH_CLIENT_SECRET`

仅当 id 与 secret 都非空时 `configured=true`，判定逻辑与 GitHub 完全一致。

### 3.2 Provider `gitee-auth.ts`

新增 `GiteeAuthProvider implements AuthProvider`：

- `readonly platform = 'gitee' as const`。
- `authorizeUrl(state, redirectUri)`：拼 `https://gitee.com/oauth/authorize?client_id&redirect_uri&response_type=code&state&scope=user_info`（`URLSearchParams` 编码）。
- `async exchangeCodeForProfile(code, redirectUri)`：
  1. `POST https://gitee.com/oauth/token`，`URLSearchParams` body 含 `grant_type=authorization_code/code/client_id/client_secret/redirect_uri`，`Accept: application/json`；非 2xx 或无 `access_token` → `throw new OAuthExchangeError(..., 502)`。
  2. `GET https://gitee.com/api/v5/user?access_token=<token>`；非 2xx → `OAuthExchangeError`。
  3. 校验 `id` 为 number、`login` 非空，否则 `OAuthExchangeError`（数据形状不符，宁失败不建脏账号）。
  4. 映射为 `OAuthProfile { platform:'gitee', providerAccountId: String(id), login, name, email, avatarUrl }`（数字 id 统一转字符串，与 GitHub provider 同形）。
- OAuth state 的生成/校验是**平台无关**的 HMAC 纯函数，直接复用 `github-auth.ts` 导出的 `generateOAuthState` / `verifyOAuthState`，不重复实现（state Cookie 名也两平台共享，见 3.4）。

### 3.3 路由注册（平台无关 helper）

`index.ts` 现有 GitHub 的 login/callback 两段约 80 行逻辑（state 校验、code 校验、交换、`upsertFromProvider`、建会话、写/清 Cookie、return_to 消费）与平台无关。抽成 `createApp` 内的一个注册函数，对 github、gitee 各调用一次，路径由平台推导：

```text
GET /auth/<platform>/login      → /auth/github/login、/auth/gitee/login
GET /auth/<platform>/callback   → /auth/github/callback、/auth/gitee/callback
```

- 未配置对应 provider 时，路由仍注册但返回 `501 { code: AUTH_NOT_CONFIGURED }`（保持 GitHub 现状，便于前端探测与排障）。
- 错误信息中的平台名（`GitHub` / `Gitee`）作为参数传入，其余错误码（invalidState 400 / exchangeFailed 502）共用 `AUTH_ERROR_CODES`。
- 回调内 `upsertFromProvider`、`authSessions.create`、`jobagent_session` 下发、`return_to` 二次校验与回跳逻辑零分支复用。
- `POST /auth/logout`、`GET /auth/me`、`POST /profiles/:id/claim`、`POST /analyze` 的登录用户分支**完全不改**：它们只依赖 `principal.platform/login`，而 principal 由 accounts 行的 platform 决定，Gitee 登录天然得到 `platform:'gitee'`。

### 3.4 临时 Cookie 的 path 泛化（必改）

现状 state / return_to 临时 Cookie 的 `Path` 写死 `/auth/github`，浏览器只在回调 `/auth/github/*` 时回传，Gitee 回调 `/auth/gitee/callback` **读不到**，会导致 Gitee 登录永远 state 校验失败。

- 将 `authStateCookieOptions` / `authReturnCookieOptions` 的 `path` 以及 callback 里两处 `deleteCookie` 的 path 统一从 `/auth/github` 改为 **`/auth`**（覆盖两个平台的回调，且仍限定在认证端点前缀下，不扩大到整站）。
- Cookie 名 `jobagent_oauth_state` / `jobagent_oauth_return` 两平台**共享**：单个用户同一时刻只会走一个 OAuth 流，不存在并发冲突；共享还能让"先点 GitHub 又改点 Gitee"自然以最后一次写入为准。

### 3.5 新增 `GET /auth/providers`（公开、只读）

报告页头部登录菜单（React island，能发 fetch）需要知道后端实际配置了哪些登录方式，避免在未配置 Gitee 时渲染一个点击后得到 501 JSON 的坏按钮。新增：

```text
GET /auth/providers → 200 { "github": { "configured": boolean }, "gitee": { "configured": boolean } }
```

- 不泄露 client id/secret，只回布尔配置态；匿名可访问、无副作用、不写日志载荷。
- 纯派生自装配后的 provider 是否为 null，可在 fake 注入下确定性单测。

### 3.6 FakeAuthProvider 可注入平台

`fake-auth.ts` 的 `platform` 现写死 `'github'`。增加构造参数 `platform: SupportedPlatform = 'github'`（默认值保证既有 GitHub 测试零改动），Gitee 集成测试传 `'gitee'` 即可走完整登录链路、不打网络。

## 4. 前端设计（报告页）

### 4.1 头部登录菜单 `AccountMenu.tsx`

- 挂载时除 `GET /auth/me` 外，再拉 `GET /auth/providers`（`credentials: 'include'`，失败静默按"仅 GitHub"或不渲染处理，与现有"拉取失败不渲染"的容错哲学一致）。
- 匿名 / 演示态：按 `providers` 的配置态渲染对应登录按钮，每个按钮都带当前页 `return_to` 深链：
  - GitHub：`${apiBase}/auth/github/login?return_to=…`，文案 `account.signInGithub`
  - Gitee：`${apiBase}/auth/gitee/login?return_to=…`，文案 `account.signInGitee`（新增 i18n）
- 已登录态（头像 / 登录名 / 退出）与平台无关，`me.platform` 已含 `gitee`，无需改。

### 4.2 授权分级闸 `GateCard.astro`（纯 SSR）

GateCard 在服务端渲染、不能 fetch，但其所在报告页**已知画像主体平台** `subjectPlatform`（ClaimProfile 已用同一变量）。据此选择登录目标，比"固定 GitHub"更贴合：

- `loginHref` 由固定 `/auth/github/login` 改为按 `subjectPlatform` 取 `/auth/github/login` 或 `/auth/gitee/login`（都带 return_to）。
- 登录按钮文案按平台选择 `report.gate.loginButtonGithub` / `report.gate.loginButtonGitee`；gate body 中"用 GitHub 登录"的措辞同样按平台取变体（title 保持平台中性）。
- 语义：被墙的是"这张平台画像"的高价值核验层，用该平台账号登录解锁最直接；招聘方若只有另一平台账号，仍可用头部 AccountMenu 的另一按钮登录（任意已登录 user 即解锁，见 design-auth-gating 两档模型）。

### 4.3 i18n（中英并行，落地即双语）

新增 key（zh-CN / en 同步，受既有 key 对齐守护测试约束）：

- `account.signInGitee`：「用 Gitee 登录」/ "Sign in with Gitee"
- `report.gate.loginButtonGitee`：「用 Gitee 登录查看」/ "Sign in with Gitee to view"
- gate body 的 Gitee 变体（证据墙 / 面试墙各一，若现有 body 含平台名）。

所有颜色/间距继续用 `--ja-*` 设计 token，多按钮布局复用 `.account-menu` 现有样式，仅加最小间距，不引入硬编码色值/尺寸。

## 5. 数据与迁移

- **零迁移、零 shared 契约改动**：`PlatformSchema` 已含 `'gitee'`；`accounts.platform`、`profiles.subject_platform`、`auth_sessions` 结构不变；`ProviderIdentity.platform` 直接收 `'gitee'`。
- accounts 仓储 `upsertFromProvider` 按 `(platform, providerAccountId)` upsert，Gitee 数字 id 转字符串后与 GitHub 同列存储，天然区分同一数字 id 跨平台碰撞（主键是平台 + id）。
- Gitee 账号的 email 可能为 null：与 GitHub 一样以 `identity.email ?? null` 落库，`/auth/me` 本就不回 email。

## 6. 测试策略（确定性，不打真实 Gitee）

后端（Vitest，内存 SQLite）：

- `gitee-auth` 纯单测（mock 全局 `fetch`）：authorizeUrl 含 `response_type=code`&`scope=user_info`&client_id&state&redirect_uri；token 请求 body 含 `grant_type=authorization_code` 与五参数；成功映射 id/login/name/email/avatar_url；token 端点非 2xx、缺 access_token、user 端点非 2xx、id 非 number / 缺 login 各自抛 `OAuthExchangeError`。
- `auth-config`：仅当 `GITEE_OAUTH_CLIENT_ID/SECRET` 都在时 `gitee.configured=true`。
- `auth-flow` 新增 Gitee 集成用例（注入 `giteeAuthProvider: new FakeAuthProvider(giteeProfile, undefined, 'gitee')`）：未配置 501；login 302 且种 state Cookie；state 缺失/不匹配 400；交换失败 502；happy path 建账号/会话、`/auth/me` 的 `platform='gitee'`；Gitee 登录用户认领本人 Gitee 画像 200、认领 GitHub 画像 403。
- `/auth/providers`：都未配置 / 仅 GitHub / 双配置三种装配下回正确布尔态。
- 既有 GitHub auth-flow / return_to 用例全绿（验证 cookie path 泛化与 helper 抽取无回归）。

前端（Vitest + Playwright，零网络，fixture/fake）：

- AccountMenu：mock `/auth/providers` 双配置时渲染两个登录按钮且 href 指向各自平台并带 return_to；仅 GitHub 时不出现 Gitee 按钮。
- E2E：Gitee 报告页的 GateCard 登录按钮指向 `/auth/gitee/login`；头部 Gitee 登录入口可见。登录回调的端到端在集成层由 fake provider 覆盖，E2E 不依赖真实 Gitee。

## 7. 安全与隐私

- 凭证只在服务端：`GITEE_OAUTH_CLIENT_SECRET` 仅服务端 env / 密钥管理，不进 Git、不下发前端、不进构建产物；`.env.example` 只占位。
- state CSRF 防护、临时 Cookie HttpOnly + SameSite=Lax + 生产 Secure、会话不透明 token、return_to 同源白名单等既有机制对 Gitee 同等生效。
- 最小 scope `user_info`，不申请仓库读写；不替用户执行任何 Gitee 写操作。
- `/auth/me` 与账号接口的最小 PII 原则不变（不回 email / 平台数字 id）。
- 账号清理 cron（`deleteUnclaimed`）平台无关，Gitee 闲置账号同样按规则回收。

## 8. 配置与文档同步

- ✅ `.env.example`：新增 `GITEE_OAUTH_CLIENT_ID` / `GITEE_OAUTH_CLIENT_SECRET` 占位与注释（本地回调 `http://localhost:3000/auth/gitee/callback`、scope `user_info`、与 GitHub 共用 `AUTH_*`）。
- ✅ [API.md](API.md) §1.2：标题改双平台、补协议差异表、`/auth/gitee/login`、`/auth/gitee/callback`、`GET /auth/providers`、Gitee env 行、状态码泛化、Cookie `Path=/auth` 同步、claim 跨平台 403 说明。
- ✅ [deferred-items](deferred-items.md)：原"Gitee OAuth 认领/登录"两处缓做项标记已落地（2026-09-19 item33），仅余 Gitee 认证态精确限频。
- ✅ [docs/README.md](README.md) 场景导航与 handoff「Project documents」索引登记本文。

> 覆盖边界（如实记录）：GateCard 的 Gitee SSR 登录墙分支**未单独写 E2E**——它是按 `subject.platform` 取平台的极简三元，平台比对已由后端 `auth-flow` Gitee 集成测试（gitee 认领本人 200 / 认领 github 画像 403）覆盖，且再造一份 Gitee SSR fixture 成本高、有回归其他 spec 风险；E2E 覆盖头部 AccountMenu 的双入口渲染（见 §6）。

## 9. 外部项（代码无法自决，部署时处理）

1. 在 Gitee「设置 → 第三方应用 / 私人令牌」对应入口创建 OAuth 应用：回调地址填 `http://localhost:3000/auth/gitee/callback`（本地）与生产 `https://<域名>/auth/gitee/callback`，权限勾选 `user_info`，取得 Client ID / Secret 后只放入 gitignored 的服务端 `.env`。
2. 生产部署需固定 `AUTH_STATE_SECRET`、正确配置 `AUTH_CALLBACK_BASE_URL`、HTTPS（Secure Cookie）、`CORS_ALLOW_ORIGINS` / `TRUST_PROXY`（跨子域形态 B 时）——与 GitHub OAuth 共用，无需新增。
3. 真实 Gitee OAuth 首次联调时，按 §2 参考来源核对实际 token / user 响应字段，必要时微调 provider 解析（测试夹具不替代一次真实冒烟）。
