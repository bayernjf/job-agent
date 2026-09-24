# JobAgent HTTP API 参考（M1 + P2 职位聚合 + 演示模式 + 岗位定向简历 + 企业人才检索/投递追踪）

- 状态：现行（M1 + P2 + Demo Mode + Targeted Resume P-R2 + 痛点解决方案批次 2 + 账号登录/本人认领 + GitHub/Gitee 双平台 OAuth + 形态 C serverless 内部 cron）
- 服务：`apps/api`（Hono），默认 `http://localhost:3000`
- 内容类型：请求/响应均为 `application/json`（健康检查与 OAuth 302 跳转除外）
- 路径前缀：Hono 内部路由即本文档所列路径（`/analyze`、`/auth/*`…），**不带 `/api` 前缀**。形态 C 同域部署时由报告站 `pages/api/[...slug].ts` 把外部 `/api/*` 剥前缀后转发，并设 `API_MOUNT_PREFIX=/api` 让 OAuth 回调 URI/Cookie Path 带上前缀；故浏览器实际访问的是 `https://<域名>/api/analyze` 等。
- CORS：默认 `*` 开放（不携带凭证 Cookie）；配置 `CORS_ALLOW_ORIGINS` 后回显具体 Origin 并允许凭证（跨域部署形态 B，见演示模式设计 §7.6）；形态 C 同域不涉及 CORS。
- 最后更新：2026-09-24（新增 `GET /health?deep=1` 深健康检查）

> 本文件只描述对外 HTTP 契约。内部分析管道见 AGENTS.md「运行架构」，画像字段结构见 `packages/shared` 的 `AbilityProfileSchema`，演示模式完整设计见 [design-demo-mode-20260915.md](design-demo-mode-20260915.md)。

---

## 通用约定

### 错误响应格式

所有 4xx/5xx 返回统一结构：

```json
{ "error": "machine-readable message", "code": "STABLE_CODE", "details": { } }
```

- `details` 仅在 400 校验失败时出现（Zod `flatten()` 结果）。
- `code` 为稳定错误码；演示模式相关为 `DEMO_REQUIRED` / `DEMO_QUOTA_EXCEEDED` / `DEMO_RATE_LIMITED`（前端据此分支处理，常量单一事实源在 `@jobagent/shared` 的 `DEMO_ERROR_CODES`）。
- 账号登录相关为 `AUTH_REQUIRED`(401) / `AUTH_NOT_PROFILE_OWNER`(403) / `AUTH_PROFILE_NOT_FOUND`(404) / `AUTH_INVALID_STATE`(400) / `AUTH_NOT_CONFIGURED`(501) / `AUTH_EXCHANGE_FAILED`(502)，常量单一事实源在 `@jobagent/shared` 的 `AUTH_ERROR_CODES`。

### 状态码约定

| 码 | 含义 |
| --- | --- |
| 200 | 成功（含去重命中、缓存命中、幂等返回） |
| 201 | 新建分析任务 / 新建演示会话成功 |
| 400 | 请求体/参数非法；OAuth 回调 state 缺失或不符（`AUTH_INVALID_STATE`） |
| 401 | 未登录访问需本人的端点（`AUTH_REQUIRED`），前端应引导 GitHub 登录 |
| 403 | 匿名触发新分析但缺少演示会话（`DEMO_REQUIRED`）；或登录用户认领非本人画像（`AUTH_NOT_PROFILE_OWNER`） |
| 404 | 任务或画像不存在；认领的画像不存在（`AUTH_PROFILE_NOT_FOUND`） |
| 429 | 演示会话配额用尽或 IP 滑动窗口超限（`DEMO_QUOTA_EXCEEDED` / `DEMO_RATE_LIMITED`） |
| 500 | 服务内部错误 |
| 501 | 某平台 OAuth 未配置（`AUTH_NOT_CONFIGURED`，缺该平台 `*_OAUTH_CLIENT_ID/SECRET`） |
| 502 | 平台授权码交换或取资料失败（`AUTH_EXCHANGE_FAILED`） |

### 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | 监听端口 |
| `DB_DRIVER` | `sqlite` | `sqlite` \| `postgres` |
| `DB_PATH` | `data/job-agent.db` | SQLite 文件路径（sqlite 时） |
| `DATABASE_URL` | — | Postgres 连接串（postgres 时）；含 `?pgbouncer=true` 或端口 6543 时自动关闭 prepared statements（Supabase 事务池化），按 `sslmode` 显式 TLS |
| `DB_AUTO_MIGRATE` | 未设置时可写连接自动迁移、只读连接不迁移 | 是否在启动时自动跑迁移；serverless 函数必须显式 `false`（DDL 只在本地用 5432 串跑 `pnpm migrate:pg:up`），仅接受小写 `true`/`false`，其它值 warn 后回退默认 |
| `API_MOUNT_PREFIX` | 空 | API 在同源下的挂载前缀，形态 C 设 `/api`；影响 OAuth `redirect_uri` 拼接与 state/return Cookie 的 `Path`（变为 `/api/auth`）。Hono 内部路由本身不带前缀，由转发层剥前缀 |
| `CRON_SECRET` | 空 | `/internal/cron/*` 鉴权密钥；配置后请求必须带 `?token=<值>`（常量时间比较），未配置时仅认 `x-vercel-cron: 1` 头。生产必填，生成：`openssl rand -hex 32` |
| `PROFILE_CACHE_TTL_MS` | `86400000`（24h） | 完整画像缓存有效期 |
| `DEMO_SESSION_TTL_MS` | `604800000`（7d） | 演示会话有效期 / Cookie Max-Age |
| `DEMO_ANALYZE_QUOTA` | `3` | 单会话可触发的新分析次数 |
| `DEMO_SESSION_RATE_PER_HOUR` | `5` | 单 IP 每小时建会话上限 |
| `DEMO_ANALYZE_RATE_PER_HOUR` | `10` | 单 IP 每小时触发分析上限 |
| `DEMO_MATCH_RATE_PER_HOUR` | `60` | match 计算 IP 兜底窗口（仅观测/防刷） |
| `DEMO_IP_SALT` | 空（进程内随机） | IP 哈希盐，生产必填 |
| `DEMO_PRESET_LOGINS` | 空 | 预置示例清单，形如 `github:alice,gitee:bob` |
| `CORS_ALLOW_ORIGINS` | 空 | 跨域 Origin 白名单（逗号分隔） |
| `TRUST_PROXY` | `false` | 反代后置 true，才采信 X-Forwarded-For |
| `GITHUB_OAUTH_CLIENT_ID` / `GITHUB_OAUTH_CLIENT_SECRET` | 空 | GitHub OAuth App 凭证；两者齐备登录路由才可用，否则 `/auth/github/*` 返回 501 |
| `GITEE_OAUTH_CLIENT_ID` / `GITEE_OAUTH_CLIENT_SECRET` | 空 | Gitee 第三方应用凭证；两者齐备 Gitee 登录路由才可用，否则 `/auth/gitee/*` 返回 501；与 GitHub 共用下方 `AUTH_*` 配置 |
| `AUTH_SESSION_TTL_MS` | `2592000000`（30d） | 登录会话有效期 / `jobagent_session` Cookie Max-Age |
| `AUTH_STATE_SECRET` | 空（进程内随机） | OAuth state 的 HMAC 密钥，生产多实例必须固定 |
| `AUTH_CALLBACK_BASE_URL` | 空（按请求推导） | OAuth 回调基址，不带尾斜杠；生产反代/跨子域时显式填域名 |
| `AUTH_AFTER_LOGIN_URL` | `/` | 登录成功后跳转地址 |

> Worker 侧另有 `DEMO_MAX_CONCURRENT`（默认 1）、`DEMO_BACKOFF_MS`（默认 15000），全部演示变量的权威表见设计文档 §13。

---

## 1. 触发分析

### `POST /analyze`

为一个用户名（GitHub 或 Gitee）创建异步分析任务。处理顺序（演示模式的关键约束）：

1. 校验请求体（400）；
2. **画像缓存命中先于一切身份检查**——任何身份（含匿名）命中未过期完整画像都直接返回、不扣配额；
3. 缓存未命中需要"触发新分析"时：**登录用户**（`jobagent_session`）经 active 去重后直接入队、不占演示配额；匿名 → `403 DEMO_REQUIRED`；演示会话再依次过 active 去重（不扣配额）→ IP 窗口 → 会话原子配额；
4. 全部通过才入队：登录任务携带 `requesterKind=user`、`demoSessionId=null`；演示任务携带 `requesterKind=demo` 与 `demoSessionId`。

响应分三种成功情况：**缓存命中**、**任务去重命中**、**新建任务**。

#### 请求体

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `username` | string | 是 | 登录名，1–39 字符；GitHub 仅允许字母数字+中划线，Gitee 额外允许下划线 |
| `platform` | `"github" \| "gitee" \| "all"` | 否 | 证据源平台，默认 `github`；`all`=一次作业采 GitHub+Gitee 并镜像去重融合成一张画像。不同平台同 login 不互相去重，`all` 缓存只认真融合画像（见 [design-cross-source-fusion §8](design-cross-source-fusion-20260915.md)） |

请求需携带演示 Cookie `jobagent_demo`（由 `POST /demo/sessions` 下发）或登录 Cookie `jobagent_session`（由 GitHub OAuth 登录下发，见 [§1.2](#12-账号登录与本人认领github-oauth)），除非命中画像缓存。CLI 不走 HTTP，不受此限。

```json
{ "username": "sindresorhus", "platform": "github" }
```

`platform:"all"` 的作业由 Worker 主采 GitHub、辅采 Gitee：两源都有账号则镜像去重后融合，画像在检索维度标记为 `all`（快照内主源仍为 GitHub）；Gitee 无同名账号（404）时正常降级为纯 GitHub 画像并在 `missing` 记 `gitee:account_not_found`，Gitee 临时故障则按普通采集错误重试。`budgetUsed` 为两源之和。

#### 响应 A：新建任务（201）

无未过期完整画像、也无进行中任务，且演示会话有剩余配额时创建。`demo.remaining` 为本会话剩余新分析次数。

```json
{
  "jobId": "job-5f8d-...",
  "status": "queued",
  "dedup": false,
  "demo": { "remaining": 2 },
  "message": "Analysis job created. Poll GET /jobs/:id for status."
}
```

#### 响应 B：任务去重命中（200）

同一用户已有 `queued`/`running` 任务时，直接返回既有任务，不重复入队。

```json
{
  "jobId": "job-5f8d-...",
  "status": "queued",
  "dedup": true,
  "message": "An active analysis job already exists for this user."
}
```

#### 响应 C：画像缓存命中（200）

该用户已存在 `complete` 画像，且生成时间在 `PROFILE_CACHE_TTL_MS` 内时，直接返回画像 id，不再创建任务。

```json
{
  "profileId": "prof-...",
  "status": "succeeded",
  "cached": true,
  "message": "A recent complete profile already exists."
}
```

#### 校验失败（400）

```json
{ "error": "validation failed", "details": { "fieldErrors": { "username": ["..."] } } }
```

#### 轮询流程

1. `POST /analyze` 拿到 `jobId`（缓存命中时直接拿 `profileId`，跳到第 3 步）。
2. 轮询 `GET /jobs/:id`，直到 `status` 为 `succeeded`/`failed`。
3. `succeeded` 后用 `profileId` 调 `GET /profiles/:id` 取完整画像。

#### 演示模式错误（403 / 429）

匿名且缓存未命中：

```json
{ "error": "demo session required to start a new analysis", "code": "DEMO_REQUIRED" }
```

会话分析次数用尽（`429`，带重置时间即会话过期时间）：

```json
{
  "error": "demo analyze quota exhausted",
  "code": "DEMO_QUOTA_EXCEEDED",
  "analyzeQuota": 3, "analyzeUsed": 3, "analyzeRemaining": 0,
  "resetAt": "2026-09-22T12:00:00.000Z"
}
```

IP 滑动窗口超限（`429`，`bucket` 为 `session` 或 `analyze`）：

```json
{ "error": "...", "code": "DEMO_RATE_LIMITED", "bucket": "analyze", "retryAfterSeconds": 3600 }
```

---

## 1.1 演示模式（免注册试用，/demo/*）

新用户无需注册，`POST /demo/sessions` 即获得服务端临时身份，凭 HttpOnly Cookie `jobagent_demo` 进入**真实产品**（真实跑分析、看真实报告）。身份介于匿名与登录用户之间，只对"触发新分析"这一消耗外部配额的动作设三道闸（会话硬配额、IP 滑动窗口、Worker 并发闸）；全部只读 GET 端点与画像缓存对任何身份开放。完整设计见 [design-demo-mode-20260915.md](design-demo-mode-20260915.md)。

### `POST /demo/sessions`

无请求体（或空对象）。已是有效演示会话时幂等返回 `200`，否则新建并通过 `Set-Cookie` 下发会话，返回 `201`。

Cookie 属性：`HttpOnly; SameSite=Lax; Path=/; Max-Age=<TTL>`，仅生产 HTTPS 加 `Secure`。

```json
{
  "kind": "demo",
  "sessionId": "demo-...",
  "expiresAt": "2026-09-22T12:00:00.000Z",
  "analyzeQuota": 3, "analyzeUsed": 0, "analyzeRemaining": 3
}
```

超过单 IP 建会话窗口返回 `429 DEMO_RATE_LIMITED`（`bucket: "session"`）。

### `GET /demo/me`

返回当前身份与配额状态。匿名：`{ "kind": "anonymous" }`；演示：同上结构并带 `analyzeUsed/analyzeRemaining`。坏/过期 Cookie 静默降级为匿名。

### `GET /demo/presets`

公开只读。返回预置示例账号数组（由 `DEMO_PRESET_LOGINS` 配置），每项标注画像快照是否就绪，前端只展示 `ready: true` 项以实现"秒进"：

```json
[
  { "platform": "github", "login": "alice", "authenticity": "likely_authentic", "profileId": "prof-...", "ready": true },
  { "platform": "github", "login": "bob", "authenticity": "unknown", "profileId": null, "ready": false }
]
```

### `POST /demo/exit`

演示会话置为 `exited` 并清除 Cookie，返回 `{ "kind": "anonymous" }`；匿名调用为 no-op。

---

## 1.2 账号登录与本人认领（GitHub / Gitee OAuth）

本人授权是产品主脊（决策 #1-A/#6-A、#4 海内外同步）：开发者用 GitHub 或 Gitee 登录后，可触发分析并**认领属于自己「平台 + 登录名」的画像**，被认领的画像才是"本人授权"的权威报告。两条登录流同构（标准 OAuth web application flow），服务端持有会话、下发 HttpOnly Cookie `jobagent_session`；某平台未配置凭证时其登录路由返回 `501 AUTH_NOT_CONFIGURED`，另一平台与其余功能（演示、浏览公开画像）不受影响。测试与本地无凭证环境用可替换的 `AuthProvider`（`FakeAuthProvider` 可注入平台），不打真实平台。

**两平台协议差异**（GitHub 见下，Gitee 完整事实表见 [design-gitee-oauth-20260919.md](design-gitee-oauth-20260919.md) §2）：

| 环节 | GitHub | Gitee |
| --- | --- | --- |
| 授权页 | `https://github.com/login/oauth/authorize`，`scope=user:email` | `https://gitee.com/oauth/authorize`，必带 `response_type=code`，`scope=user_info` |
| 换 token | `POST https://github.com/login/oauth/access_token` | `POST https://gitee.com/oauth/token`，表单必带 `grant_type=authorization_code` |
| 取用户 | `GET https://api.github.com/user`，`Authorization: Bearer` | `GET https://gitee.com/api/v5/user?access_token=<token>`（token 走 query） |
| 账号键 | `(platform='github', providerAccountId=数字 id)` | `(platform='gitee', providerAccountId=数字 id)` |

登录态与演示态互斥解析：请求带有效 `jobagent_session` 时 Principal 为 `user`（优先），否则回退演示会话 `jobagent_demo`，再否则匿名。临时 `state`/`return_to` Cookie 的 `Path=/auth`（两平台回调 `/auth/<platform>/callback` 都能读到）。

### `GET /auth/github/login`

无请求体。服务端生成 HMAC 签名的 `state`，写入临时 Cookie `jobagent_oauth_state`（`HttpOnly; SameSite=Lax; Path=/auth; Max-Age=600`，仅生产 HTTPS 加 `Secure`），并 `302` 跳转到 GitHub 授权页（`scope=user:email`，仅为尽力取邮箱，邮箱可空）。

**Query 参数 `return_to`（可选）**：登录成功后的回跳深链。仅接受**同源相对路径**——必须以单个 `/` 开头、第二字符不得是 `/` 或 `\`（拦 `//host`、`/\host` 协议相对跳转），拒绝对 URL/任意 scheme、控制字符（CR/LF/Tab）、超长（>2048）以及回 `/auth/`（防登录环）。合法值写入临时 Cookie `jobagent_oauth_return`（`HttpOnly; SameSite=Lax; Path=/auth; Max-Age=600`）；非法/缺失则登录后回退 `AUTH_AFTER_LOGIN_URL`。该值**不进 GitHub `state`、不落日志**，回调时二次校验、用完即删（防开放重定向）。

- `302`：`Location` 为 GitHub 授权 URL，`Set-Cookie: jobagent_oauth_state=...`（合法 `return_to` 时另含 `jobagent_oauth_return=...`）。
- `501 AUTH_NOT_CONFIGURED`：服务端未配置 OAuth 凭证。

### `GET /auth/github/callback`

GitHub 授权后回跳（携带 `code` 与 `state`）。服务端校验 query `state` 与 state Cookie 一致且 HMAC 签名有效（防 CSRF），再用 `code` 换 access token、取 GitHub 用户资料，按 `(platform, providerAccountId)` upsert 账号，创建登录会话并下发 `jobagent_session`，随后清除 state Cookie 与 return Cookie：若登录请求携带了合法的同源 `return_to`（再次白名单校验）则 `302` 回该深链，否则回 `AUTH_AFTER_LOGIN_URL`（默认 `/`）。

- `302`：`Set-Cookie: jobagent_session=ses-...; HttpOnly; SameSite=Lax; Path=/; Max-Age=<AUTH_SESSION_TTL_MS>`。
- `400 AUTH_INVALID_STATE`：缺 `state`/`code`、state Cookie 缺失、query 与 Cookie 不符或签名无效。
- `502 AUTH_EXCHANGE_FAILED`：授权码换 token 或取用户资料失败（上游非 2xx、响应畸形）。

### `GET /auth/gitee/login` / `GET /auth/gitee/callback`

与 GitHub 完全对称的 Gitee OAuth web flow（决策 #4 海内外同步）。login 写同样的 `jobagent_oauth_state`（及可选 `jobagent_oauth_return`）Cookie 后 302 到 Gitee 授权页（必带 `response_type=code`、`scope=user_info`）；callback 校验 state，用授权码以表单 `grant_type=authorization_code` 换 token，再以 `?access_token=<token>` query 调 `gitee.com/api/v5/user`，按 `(platform='gitee', providerAccountId=<数字 id>)` upsert 账号、建会话、清临时 Cookie，并按 `return_to` / `AUTH_AFTER_LOGIN_URL` 回跳。状态码与 GitHub 两条完全一致（`302` / `400 AUTH_INVALID_STATE` / `501 AUTH_NOT_CONFIGURED` / `502 AUTH_EXCHANGE_FAILED`）。Gitee 用户 `email` 常为 `null`（隐私邮箱是常态），不影响登录与认领。完整协议事实表见 [design-gitee-oauth-20260919.md](design-gitee-oauth-20260919.md)。

### `GET /auth/providers`

公开只读、无需登录，返回各平台 OAuth 是否已配置（**仅布尔态，不含任何凭证**），供前端（报告页 `AccountMenu`）决定渲染哪些登录入口；拉取失败时前端保守回退为仅显示 GitHub：

```json
{ "github": { "configured": true }, "gitee": { "configured": false } }
```

### `POST /auth/logout`

撤销当前登录会话（置 `revoked`）并清除 `jobagent_session`，返回 `{ "ok": true }`；匿名调用为 no-op。

### `GET /auth/me`

返回当前登录身份。匿名/演示返回 `{ "kind": "anonymous" }` 或 `{ "kind": "demo" }`；登录用户：

```json
{
  "kind": "user",
  "accountId": "acc-...",
  "platform": "github",
  "login": "alice",
  "name": "Alice",
  "avatarUrl": "https://avatars.githubusercontent.com/u/101",
  "claimedProfileId": "prof-...",
  "expiresAt": "2026-10-18T00:00:00.000Z"
}
```

> 刻意**不返回** `email` 与平台数字 `providerAccountId`（最小对外暴露）；邮箱仅服务端留存。坏/过期/已撤销会话 Cookie 静默降级为匿名。

### `POST /profiles/:id/claim`

登录用户认领本人画像。仅当画像的 `subject.platform` + `subject.login` 与登录账号完全一致才放行（Gitee 登录不能认领 GitHub 画像，反之亦然，跨平台/异名返回 403）；成功后画像 `subject.claimed=true`、账号记录 `claimedProfileId`。

```json
{
  "profileId": "prof-alice",
  "claimed": true,
  "subject": { "platform": "github", "login": "alice" },
  "claimedProfileId": "prof-alice"
}
```

| 码 | 情形 |
| --- | --- |
| 200 | 认领成功（幂等，重复认领同一画像仍成功） |
| 400 | `id` 格式非法 |
| 401 `AUTH_REQUIRED` | 未登录（匿名/演示会话） |
| 403 `AUTH_NOT_PROFILE_OWNER` | 画像平台登录名与登录账号不一致（响应带画像 `subject`） |
| 404 `AUTH_PROFILE_NOT_FOUND` | 画像不存在 |

### 授权分级闸与可见性（报告页，2026-09-19 落地）

登录除认领外，还解锁报告页（Astro SSR，直读只读 storage）的完整核验内容。采用**两档模型**：未登录（anonymous/demo）看公开门面，登录 `user`（含本人与登录的招聘方，可见性相同；本人额外只有认领能力）可见全部。

| 报告内容 | 未登录 | 登录 user |
| --- | --- | --- |
| 头部 / 摘要 / 真实性分级与置信度 / 信号 label·detail / 技能标签名与深度 / 协作聚合 / caveats | 可见 | 可见 |
| 岗位推荐、岗位定向简历、投递追踪、岗位匹配卡片及其匹配理由证据 | 可见 | 可见 |
| 招聘方核验视图（`?view=recruiter`）三处原始证据外链（信号 / 技能 / 面试题依据） | 折叠为登录墙 | 可见 |
| 面试题题目与考察意图 | 折叠为「题数 + 登录墙」 | 可见 |
| 面试准备包 Markdown 下载（报告页端点 `GET /[locale]/report/:id/interview-kit.md`） | 隐藏下载链接，端点返回 `401` | `200` 下载 |

- 报告页身份在 SSR 读 `jobagent_session` + 只读 storage 解析（`resolveViewer`），坏/过期 Cookie 与只读查询异常一律静默降级匿名，不拖垮页面；登录墙按钮携带当前页 `return_to` 深链。
- **JSON API 不在本刀范围**：`GET /profiles/:id` 与 `GET /profiles/:id/exportable` 保持公开（浏览器扩展一键填充依赖 exportable，其投影本身不含证据 URL 与面试题）；未登录 API 面本就基本拿不到证据 URL（exportable 无、snapshot 内仅 evidenceId）。对 API 响应做字段级裁剪（连面试题文本也裁掉）缓做，触发条件＝对外公开分享后出现 API 抓取/搬运滥用（见 [deferred-items](deferred-items.md)）。

---

## 2. 查询任务状态

### `GET /jobs/:id`

#### 路径参数

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | `POST /analyze` 返回的 jobId |

#### 响应（200）

```json
{
  "id": "job-...",
  "subject": { "platform": "github", "login": "sindresorhus" },
  "status": "succeeded",
  "stage": "L1",
  "attempts": 1,
  "profileId": "prof-...",
  "error": null,
  "budgetUsed": { "graphqlPoints": 42 },
  "missing": [],
  "createdAt": "2026-09-11T08:00:00.000Z",
  "updatedAt": "2026-09-11T08:00:05.000Z",
  "startedAt": "2026-09-11T08:00:01.000Z",
  "finishedAt": "2026-09-11T08:00:05.000Z"
}
```

#### `status` 取值

| 值 | 含义 |
| --- | --- |
| `queued` | 已入队，等待 Worker 认领 |
| `running` | Worker 分析中（配合 `stage` 看 L0/L1 进度） |
| `succeeded` | 完成，`profileId` 可用 |
| `failed` | 失败，`error` 给出原因，`missing` 标注缺失层 |

#### 不存在（404）

```json
{ "error": "job not found" }
```

---

## 3. 查询画像快照

### `GET /profiles/:id`

返回不可变画像快照（分享链接永远指向生成时版本）。

#### 响应（200，节选）

```json
{
  "id": "prof-...",
  "analyzerVersion": "schema-0.1-engine-0.1.0",
  "subject": { "platform": "github", "login": "sindresorhus", "claimed": false },
  "dataWindow": { "since": "...", "until": "..." },
  "analysisLayers": ["L0", "L1"],
  "status": "complete",
  "snapshot": { },
  "createdAt": "...",
  "updatedAt": "..."
}
```

`snapshot` 为完整 `AbilityProfile`，字段契约以 `packages/shared` 为准，主要包含：

- `summary.headline` / `summary.seniorityHint`
- `skillTags[]`（name/kind/depth/confidence/evidenceRefs）
- `activity`（longevityMonths、cadenceSummary、metrics）
- `collaboration`（prSummary、externalMergedContributions）
- `authenticity`（status、confidence、signals[]）
- `interviewQuestions[]`、`caveats[]`

#### 不存在（404）

```json
{ "error": "profile not found" }
```

---

## 3.0 按主体账号查询最新完整画像

### `GET /profiles/by-subject/:platform/:login`

按证据源平台与账号 login 反查该主体最近一版 `complete` 画像的轻量指针，供已持有账号身份的调用方在触发新分析前判断是否已有可引用画像。

- 路径参数：`platform`（`github` / `gitee`）、`login`（平台账号 login）；校验失败返回 400。
- 命中（200）：

```json
{
  "profileId": "prf_...",
  "status": "complete",
  "cached": true,
  "analyzerVersion": "0.3",
  "updatedAt": "2026-09-20T08:00:00.000Z"
}
```

- 无完整画像（404）：`{ "error": "no complete profile for subject", "code": "PROFILE_NOT_FOUND" }`

---

## 3.1 查询可导出画像（P1 扩展消费）

### `GET /profiles/:id/exportable`

返回服务端投影后的**可导出画像**（`ExportableProfile`），供 Chrome 扩展等外部消费方直接使用，无需解包存储行。

- 由服务端对 `snapshot` 调用 `toExportableProfile` 投影（`packages/shared`），缺 `snapshot` 返回 404。
- 字段契约：`schemaVersion`（当前 `0.1`）、`subject`（displayName/login/profileUrl）、`headline`、`authenticity`（status/confidence）、`skills[]`（name/confidence/evidenceRefs）、`summary` 等，以 `packages/shared` 的 `ExportableProfileSchema` 为准。

#### 响应（200，节选）

```json
{
  "schemaVersion": "0.1",
  "subject": { "platform": "github", "login": "sindresorhus", "displayName": "Sindre Sorhus", "profileUrl": "https://github.com/sindresorhus" },
  "headline": "Sindre Sorhus — ...",
  "authenticity": { "status": "likely_authentic", "confidence": 0.82 },
  "skills": [ { "name": "TypeScript", "confidence": 0.9, "evidenceRefs": ["..."] } ],
  "summary": "..."
}
```

#### 不存在（404）

```json
{ "error": "profile not found" }
```

---

## 3.2 查询画像岗位推荐（第一档匹配接线）

### `GET /profiles/:id/job-recommendations`

以画像快照的 `skillTags[].name` 为技能集，先取候选岗位池，再按与 [`POST /job-postings/match`](#33-职位聚合岗位检索与画像匹配p2-d) 相同的加权规则打分，返回该画像的岗位推荐。报告页「为你推荐的岗位」island 即消费此端点（同源调用）。

#### 路径参数

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 画像 id，非法格式返回 400 |

#### Query 参数（全部可选）

| 参数 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `remote` | `true` \| 其它 | — | 仅 `"true"` 视为只看远程 |
| `sources` | string | — | 逗号分隔数据源（如 `remoteok,lever`），出现非法值返回 400 |
| `salary_min` | number | — | 薪资下限（USD，非负整数），非法返回 400 |
| `limit` | number | `20` | 返回上限，1–100，越界返回 400 |
| `candidate_limit` | number | `500` | 候选池大小，1–500，越界返回 400 |

#### 响应（200）

```json
{
  "profileId": "prof-...",
  "profileSkills": ["TypeScript", "React"],
  "matches": [
    {
      "score": 9,
      "matchedSkills": ["TypeScript", "React"],
      "fieldScores": { "title": 3, "tags": 4, "description": 2 },
      "skillHits": [
        { "skill": "TypeScript", "score": 5, "fields": ["title", "tags"] },
        { "skill": "React", "score": 4, "fields": ["tags", "description"] }
      ],
      "skillReasons": [
        {
          "skill": "TypeScript",
          "score": 5,
          "fields": ["title", "tags"],
          "kind": "language",
          "depth": "proficient",
          "confidence": 0.9,
          "evidenceRefs": ["ev-001"]
        }
      ],
      "posting": { "jobId": "...", "source": "remoteok", "title": "...", "company": "...", "sourceUrl": "..." }
    }
  ],
  "evidence": {
    "ev-001": { "sourceType": "commit", "url": "https://github.com/...", "claim": "...", "occurredAt": "...", "layer": "L1" }
  },
  "total": 1,
  "candidatePool": 120
}
```

- `profileSkills`：从画像快照提取的技能名（即实际参与匹配的技能集）。
- `matches[]`：打分规则、字段语义与 `POST /job-postings/match` 完全一致（title×3 / tags×2 / description×1，至少命中一个技能才入选，按分降序）。
- **可解释性字段（决策 #10）**：
  - `fieldScores`：分数在标题/标签/正文上的分解，三项之和 = `score`。
  - `skillHits`：每个命中技能各自命中了哪些字段、贡献多少分。
  - `skillReasons`：仅 profileId 匹配时返回，在 `skillHits` 基础上挂画像技能元数据（`kind`/`depth`/`confidence`）与证据指针 `evidenceRefs`。
  - `evidence`：**响应顶层**的去重证据字典，key = `evidenceRef`，供前端回溯证据原链；旧后端可能缺，前端应健壮降级。
- `candidatePool`：过滤后、打分前的候选岗位数，便于解释「为什么只推荐这么少」。
- 画像 `skillTags` 为空时返回 200，`matches` 为空数组（不报错）。

#### 错误

| 码 | 情形 |
| --- | --- |
| 400 | `id` 格式非法，或 query 参数非法（响应带具体字段说明） |
| 404 | 画像不存在（`profile not found`），或画像无快照（`profile has no snapshot`） |

---

## 3.3 职位聚合：岗位检索与画像匹配（P2-D）

岗位数据由离线采集管道写入（CLI `jobs sync`，见 `docs/design-job-ingestion-20260913.md`），API 只做只读检索与匹配。注意分析任务已占用 `/jobs/:id`，故岗位端点统一用 `/job-postings`。

### `GET /job-postings`

岗位检索（薄封装仓储 `search`），默认只返回 `active`。

#### Query 参数

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `keyword` | string | 关键词，词间 AND，命中 title/company/tags |
| `remote` | `true` \| `false` | 是否仅远程 |
| `sources` | string | 逗号分隔数据源（如 `remoteok,lever`），出现非法值返回 400 |
| `company` | string | 公司名过滤 |
| `tags` | string | 逗号分隔标签（OR） |
| `salaryMinUsd` | number | 薪资下限（USD，按 `COALESCE(salaryMax,salaryMin)` 比较） |
| `postedAfter` | ISO datetime | 仅该时间之后发布 |
| `limit` | number | 默认 100，上限 500 |
| `offset` | number | 分页偏移 |
| `orderBy` | `posted_desc` \| `posted_asc` \| `salary_desc` | 默认 `posted_desc` |

#### 响应（200）

```json
{
  "items": [
    { "jobId": "...", "source": "remoteok", "title": "Senior Python Engineer", "company": "...", "remote": true, "tags": ["python"], "postedAt": "...", "sourceUrl": "..." }
  ],
  "limit": 100,
  "offset": 0
}
```

### `GET /job-postings/stats`

按源统计在招/失效岗位数。该静态路径必须在 `/job-postings/:id` 之前注册，否则 `stats` 会被当成 id。

```json
{ "active": { "remoteok": 99, "lever": 12 }, "inactive": { "remoteok": 3 } }
```

### `GET /job-postings/:id`

按内部稳定 id（由 `source + sourceUrl` 派生）取单条岗位；不存在返回 404。

### `POST /job-postings/match`

先用结构化条件取候选池（默认最近 500 条），再按技能名对 title（权重 3）/tags（权重 2）/description（权重 1）做词边界加权打分，按分数降序返回；至少命中一个技能才会出现在结果里。技能来源二选一：直接传 `skills`，或传 `profileId` 由服务端从画像快照取 `skillTags[].name`（**profileId 优先**）；后者响应额外带 `profileSkills` 字段，回显实际参与匹配的技能。

#### 请求体

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `skills` | string[] | **二选一** | 技能名列表；与 `profileId` 至少提供一个，两者都缺返回 400 |
| `profileId` | string | **二选一** | 画像 id；提供后从其快照 `skillTags[].name` 取技能，**优先级高于 `skills`**；画像不存在/无快照返回 404 |
| `remote` | boolean | 否 | 硬过滤：仅远程 |
| `salaryMinUsd` | number | 否 | 硬过滤：薪资下限（无薪资岗位不满足） |
| `sources` | string[] | 否 | 硬过滤：限定数据源 |
| `keyword` / `company` / `tags` / `postedAfter` | — | 否 | 候选池过滤，语义同 GET |
| `candidateLimit` | number | 否 | 候选池大小，默认 500，上限 500 |
| `limit` | number | 否 | 返回上限，默认 50，上限 500 |

#### 请求 / 响应

```json
// 请求
{ "skills": ["Python", "React"], "remote": true, "limit": 5 }
// 响应（200，传 profileId 时额外回显 profileSkills 与顶层 evidence）
{
  "matches": [
    {
      "score": 5,
      "matchedSkills": ["Python", "React"],
      "fieldScores": { "title": 3, "tags": 2, "description": 0 },
      "skillHits": [
        { "skill": "Python", "score": 3, "fields": ["title"] },
        { "skill": "React", "score": 2, "fields": ["tags"] }
      ],
      "posting": { "title": "...", "source": "remoteok", "sourceUrl": "..." }
    }
  ],
  "total": 1,
  "profileSkills": ["Python", "React"],
  "evidence": { "ev-001": { "sourceType": "commit", "url": "...", "claim": "..." } }
}
```

- **可解释性字段（决策 #10）**：`fieldScores`（三项和=score）、`skillHits`（逐技能字段级命中）始终返回；`skillReasons`（挂画像元数据与证据指针）与顶层 `evidence` 字典仅在传 `profileId` 时返回；旧后端可能缺可解释字段，调用方应健壮降级。

#### 错误

| 码 | 情形 |
| --- | --- |
| 400 | 非法 JSON；请求体校验失败；`skills` 与 `profileId` 都未提供 |
| 404 | 传了 `profileId` 但画像不存在或无快照 |

---

## 3.4 岗位定向简历生成（P-R2）

### `POST /resumes/build`

针对**一个岗位**，把画像快照中**有证据可回溯**的技能与成果，经选择、排序、模板装配成一份岗位定向简历（设计文档 `docs/design-targeted-resume-20260915.md`）。纯计算、只读：**不触发新分析、不消耗平台采集配额、不写库、不写访问日志内容**；匹配分在请求时基于该岗位现算，零命中走 `low` 分档降级。与 GET 画像/推荐一样对所有身份公开。

三条不变量（no-fabrication）：

1. 正文里 `source:'profile'` 的每条目都带非空 `evidenceRefs`，指向该画像的 `EvidenceItem.evidenceId`；**画像里 `evidenceRefs` 为空的技能 tag 不会写进简历正文**（完整技能仍在画像页展示）；
2. 画像不提供的字段（联系方式、教育、工作经历）只来自请求体 `local`，标 `source:'local'`、refs 为空，服务端不持久化；
3. 输出经 `ResumeDraftSchema` 校验并带 `provenance`（profileId / analyzerVersion / ruleVersion），规则版本变更时 bump `RESUME_RULE_VERSION`。

#### 请求体

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `profileId` | string | **是** | 画像 id；不存在或无快照返回 404 |
| `jobId` | string | **是** | 岗位**内部主键**（`job_postings.id`，即推荐/检索响应里 `posting.id`，非外部 `jobId`）；不存在返回 404 |
| `local` | object | 否 | 本地补填字段，仅用于本次渲染，**不入库、不落日志**；结构见下 |
| `locale` | `"zh-CN"` \| `"en"` | 否 | 文案语言，默认 `zh-CN`；非法值 400 |
| `format` | `"json"` \| `"md"` \| `"html"` | 否 | 默认 `json`（仅结构化草稿）；`md`/`html` 额外返回渲染字符串 |
| `highlightLimit` | number | 否 | 证据亮点上限，正整数，最大 50；默认取内核常量（10） |
| `polish` | boolean | 否 | 是否请求 **B 档 LLM 措辞润色**，默认 `false`（纯规则版，零费用、零数据外发）。见下「LLM 措辞润色」 |

`local` 子结构（全部可选；空白字符串与不完整行会被服务端/客户端剔除；`personalSite` 须为合法 URL）：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `fullName` / `email` / `phone` / `location` | string | 联系信息 |
| `personalSite` | string(url) | 个人主页 |
| `education[]` | `{ school(必填), degree(必填), period? }` | 教育经历，`period` 自由文本如 `"2018–2022"` |
| `workHistory[]` | `{ company(必填), role(必填), period?, detail? }` | 工作经历 |

#### 请求 / 响应

```json
// 请求
{
  "profileId": "p-abc",
  "jobId": "job-uuid",
  "locale": "zh-CN",
  "format": "html",
  "local": { "fullName": "Alice Zhang", "email": "alice@example.com" }
}
```

```json
// format 省略 / json → 200
{ "draft": { "schemaVersion": "...", "ruleVersion": "0.1", "generatedAt": "...",
  "subject": { "login": "alice", "profileUrl": "..." },
  "targetJob": { "jobId": "ext-1", "title": "Senior TypeScript Engineer", "company": "Acme",
    "sourceUrl": "...", "matchScore": 7, "tier": "high",
    "matchedSkills": ["typescript"], "fieldScores": { "title": 3, "tags": 2, "description": 2 } },
  "header": { "...": "name/headline/contact" },
  "summary": "…（仅由画像/岗位/匹配槽位模板组装）",
  "matchedSkills": [ { "text": "typescript", "source": "profile", "evidenceRefs": ["ev-ts1"], "depth": "proficient" } ],
  "otherSkills": [ { "text": "rust", "source": "profile", "evidenceRefs": ["ev-rs"] } ],
  "evidenceHighlights": [ { "text": "Merged a TypeScript fix", "source": "profile", "evidenceRefs": ["ev-ts1"], "url": "..." } ],
  "collaboration": [],
  "localSections": { "education": [], "workHistory": [] },
  "suggestions": [ { "kind": "missing_skill", "text": "…" } ],
  "gaps": [ "…（画像缺失、需用户补填的字段）" ],
  "provenance": { "profileId": "p-abc", "analyzerVersion": "…", "ruleVersion": "0.1" } } }

// format=html → 200：{ "format": "html", "draft": { /* 同上 */ }, "html": "<!DOCTYPE html>…（含 @media print，可直接 iframe srcDoc 预览/打印为 PDF）" }
// format=md   → 200：{ "format": "md",   "draft": { /* 同上 */ }, "markdown": "# …" }
```

- `tier`：`high` / `mid` / `low`，由 `matchScoreTier(score, matchedSkills.length)` 相对分档，与推荐/扩展一致。
- `suggestions[].kind`：`missing_skill`（岗位要求但画像没有，仅提示不写进正文）/ `missing_field`（缺联系方式/教育/工作）/ `low_match`（零命中或低分）。
- **HTML 已内置 `@media print` 的 A4 适配**：前端用浏览器"打印 → 另存 PDF"即可，服务端不引入 puppeteer（设计 §10 #3 **已决策**：保持浏览器打印 CSS）。

#### LLM 措辞润色（B 档，可选，默认关闭）

- 仅当请求体 `polish:true` 且服务端配置了 OpenAI 兼容 LLM（环境变量 `LLM_API_KEY` + `LLM_MODEL`，可选 `LLM_BASE_URL`/`LLM_PROVIDER`/`LLM_TIMEOUT_MS`，见 `.env.example`）时才会调用模型；未配置时直接返回规则版，**不报错、不产生费用、不外发数据**。
- 模型只允许润色 `summary` 与证据亮点的**措辞**，不能新增/删除/重排任何条目，也**不得引入任何新数字**（年份、百分比、指标等）。润色结果经 `resume-core` 纯安全层复核：长度、下标、数字集合（新文本数字必须是规则版草稿数字的子集）与 `ResumeDraftSchema` 复校；任一违例或模型/网络错误都**整条回退规则版**。
- 无论是否真正润色，`polish:true` 的响应都带一个 `polish` 状态对象（不请求时该字段缺省）：

```json
// 润色通过
{ "draft": { "...": "summary 已为模型措辞，provenance.polish 记录来源",
  "provenance": { "profileId": "p-abc", "ruleVersion": "0.1",
    "polish": { "provider": "deepseek", "model": "deepseek-chat",
      "promptVersion": "resume-polish-0.1", "appliedAt": "2026-09-16T00:00:00.000Z" } } },
  "polish": { "requested": true, "applied": true } }

// 未配置 LLM / 安全层拒绝（fabrication_detected | validation_failed）/ provider_error → 回退规则版
{ "draft": { "...": "原规则版，provenance 无 polish" },
  "polish": { "requested": true, "applied": false, "reason": "not_configured" } }
```

- `reason`：`not_configured`（服务端未配 LLM）/ `provider_error`（HTTP、超时、非 JSON 输出）/ `validation_failed`（长度或结构违例）/ `fabrication_detected`（模型吐出规则版中不存在的新数字）。
- 前端报告页当前默认不发 `polish`（规则版）；AI 润色开关属于后续 UI 项（见 handoff item19）。

#### 错误

| 码 | 情形 |
| --- | --- |
| 400 | 非法 JSON；缺 `profileId`/`jobId`；`locale`/`format` 非法；`highlightLimit` 越界；`local` 校验失败（如 `personalSite` 非 URL、education 缺 school/degree） |
| 404 | 画像不存在/无快照，或岗位不存在 |
| 500 | 已存储的岗位记录不符合契约（数据异常，正常不会发生） |

---

## 3.5 企业人才检索（筛选工作台）

### `GET /candidates`

在**已生成的完整画像**（`profiles.status='complete'`）范围内做多维筛选与排序，供企业侧人才筛选工作台（报告站 `/[locale]/recruit`，首屏由 SSR 直连只读仓储渲染，交互过滤调本端点）使用。**只读，不触发任何新采集**，也不暴露画像之外的个人信息。

实现上仓储层先用一条粗筛 SQL 取最近不超过 1000 条 complete 画像（刻意规避 SQLite/Postgres 的 JSON 查询方言差异），技能/真实性/置信度/关键词等精细过滤与排序全部在源无关的纯函数层（`packages/storage` 的 `searchCandidates`）完成。

#### Query 参数（全部可选）

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `keyword` | string | 自由文本，按空白拆词，**词间 AND**，每个词需命中 login / displayName / headline / 技能名之一（大小写不敏感） |
| `skills` | string | 逗号分隔的技能名，按技能名双向包含匹配（大小写不敏感） |
| `skillMatch` | `any` \| `all` | 多技能匹配方式：`any`=命中任一（默认，召回优先）；`all`=全部命中（精准） |
| `authenticity` | string | 逗号分隔的真实性状态白名单（OR），取值 `likely_authentic` / `mixed_signals` / `suspicious` / `insufficient_data`；含未知值整体 400 |
| `minConfidence` | number(0..1) | 仅保留 `authenticity.confidence >= 该值` |
| `platform` | `github` \| `gitee` | 按证据源平台过滤 |
| `sortBy` | `confidence_desc` \| `skill_count_desc` \| `recent` | 排序，默认 `confidence_desc`（真实性置信度优先） |
| `limit` | int(1..100) | 每页条数，默认 20 |
| `offset` | int(≥0) | 分页偏移，默认 0 |

#### 响应（200）

```json
{
  "items": [
    {
      "profileId": "prof...",
      "platform": "github",
      "login": "alice",
      "displayName": "Alice",
      "avatarUrl": "https://avatars.githubusercontent.com/u/...",
      "profileUrl": "https://github.com/alice",
      "claimed": false,
      "headline": "frontend developer",
      "seniorityBand": "mid",
      "authenticity": { "status": "likely_authentic", "confidence": 0.9 },
      "skills": [
        { "name": "TypeScript", "kind": "language", "depth": "proficient", "confidence": 0.8 }
      ],
      "skillCount": 2,
      "matchedSkills": ["TypeScript"],
      "updatedAt": "2026-09-16T00:00:00.000Z"
    }
  ],
  "total": 1,
  "limit": 20,
  "offset": 0
}
```

- `items[]` 为候选人**摘要**（`CandidateSummary`）；完整画像走 [`GET /profiles/:id`](#3-查询画像快照)，招聘方核验视图走 `/[locale]/report/<profileId>?view=recruiter`。
- `total` 为过滤后、分页前的总数；`matchedSkills` 回填本次技能过滤命中的技能名（未按技能过滤时为空）。
- 无可选画像时返回 `{ "items": [], "total": 0, ... }`。

#### 错误

| 码 | 情形 |
| --- | --- |
| 400 | 非法枚举（`skillMatch`/`platform`/`sortBy`/`authenticity` 含未知值）、`minConfidence` 越界、`limit`/`offset` 非整数或越界 |

## 3.6 投递记录追踪（求职者侧）

以画像为归属记录求职者的投递动作与进展，供报告页「投递追踪」island 与（后续）浏览器扩展回写。**只做新增与状态流转，不物理删除**；撤回用 `status=withdrawn` 表达。

`status` 取值：`saved`（待投递）/ `applied`（已投递，默认）/ `viewed`（被查看/初筛）/ `interview`（面试中）/ `offer` / `rejected` / `withdrawn`（主动撤回）。
`origin` 取值：`manual`（报告页手录，默认）/ `report` / `extension`（扩展回写）。

### `GET /profiles/:id/applications`

列出某画像的全部投递记录，按 `applied_at` 倒序。

#### 响应（200）

```json
{
  "items": [
    {
      "id": "app-<uuid>",
      "profileId": "prof...",
      "jobId": null,
      "source": "greenhouse",
      "targetTitle": "Senior Engineer",
      "targetCompany": "Acme",
      "targetUrl": "https://example.test/job/1",
      "status": "interview",
      "note": "约了一面",
      "origin": "manual",
      "appliedAt": "2026-09-16T00:00:00.000Z",
      "createdAt": "2026-09-16T00:00:00.000Z",
      "updatedAt": "2026-09-16T00:00:00.000Z"
    }
  ]
}
```

画像不存在返回 404；画像存在但无记录返回 `{ "items": [] }`。

### `POST /profiles/:id/applications`

新增一条投递记录。

#### 请求体

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `targetTitle` | string | 是 | 目标岗位名称 |
| `targetCompany` | string | 是 | 目标公司 |
| `targetUrl` | string(url) | 否 | 岗位链接 |
| `jobId` | string | 否 | 内部 `job_postings.id`（从推荐岗位投递时回填） |
| `source` | string | 否 | 岗位来源 key（remoteok/greenhouse/…） |
| `status` | enum | 否 | 默认 `applied` |
| `origin` | enum | 否 | 默认 `manual` |
| `note` | string | 否 | 备注 |
| `appliedAt` | string(ISO8601 datetime) | 否 | 默认服务端当前时间 |

#### 响应

- `201`：返回创建后的完整记录（字段同 GET 单项，`id` 形如 `app-<uuid>`）。
- `400`：非法 JSON、缺 `targetTitle`/`targetCompany`、`targetUrl` 非 URL、枚举非法、`appliedAt` 非 ISO 时间。
- `404`：画像不存在。

### `PATCH /applications/:id`

局部更新一条投递记录（状态流转、备注、投递时间、岗位链接）。

#### 请求体（至少一个字段）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `status` | enum | 新状态；主动撤回传 `withdrawn` |
| `note` | string \| null | 备注，传 `null` 清空 |
| `appliedAt` | string(ISO8601 datetime) | 更正投递时间 |
| `targetUrl` | string(url) \| null | 岗位链接，传 `null` 清空 |

#### 响应

- `200`：返回更新后的完整记录。
- `400`：非法 JSON、请求体为空（无任何可更新字段）、枚举/URL/时间格式非法。
- `404`：投递记录不存在。

---

## 3.7 面试计划（招聘方侧，需登录）

招聘方在「候选人画像 × 目标岗位」上安排面试、流转状态、登记结果，供报告页 `/recruit` 招聘方视图的「面试计划」island 使用。

- **三个端点都要求登录**（携带 `jobagent_session` Cookie）；未登录一律 `401`（`code: AUTH_AUTH_REQUIRED`）。
- **行级隔离**：只能读到/改到当前登录账号创建的面试；访问他人面试返回 `404`（不泄露资源是否存在）。
- **不物理删除**：取消/爽约用状态 `cancelled` / `no_show` 表达。
- `format` 取值：`onsite` / `phone` / `video`。
- `status` 取值：`scheduled`（待面试，默认）/ `completed`（已完成）/ `cancelled`（已取消）/ `no_show`（爽约）/ `rescheduled`（已改期）。
- `outcome` 取值（可空，通常完成后登记）：`strong_yes` / `yes` / `neutral` / `no`。

### `POST /interviews`

为候选人安排一场面试。可关联一条该候选人的投递记录；关联后若该投递仍处于 `saved`/`applied`/`viewed` 早期阶段，会被自动推进到 `interview`（`offer`/`rejected`/`withdrawn` 等终态不回退）。

#### 请求体

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `profileId` | string | 是 | 候选人画像 id |
| `targetTitle` | string | 是 | 面试目标岗位名称（冗余自投递/岗位，列表直接展示） |
| `scheduledStart` | string(ISO8601 datetime) | 是 | 开始时间（UTC） |
| `scheduledEnd` | string(ISO8601 datetime) | 是 | 结束时间，必须晚于开始时间 |
| `format` | enum | 是 | `onsite` / `phone` / `video` |
| `roundLabel` | string | 是 | 轮次自由文本，如「一面 · 技术筛」 |
| `targetCompany` | string | 否 | 目标公司，可空 |
| `interviewerName` | string | 否 | 面试官姓名（自由文本，单条） |
| `interviewerEmail` | string(email) | 否 | 面试官邮箱，可空 |
| `applicationId` | string | 否 | 关联的投递记录 id；须属于同一 `profileId` |

#### 响应

- `201`：返回创建后的完整记录，`id` 形如 `int-<uuid>`，默认 `status=scheduled`，`outcome`/`rating`/`feedbackNote` 为 `null`。
- `400`：非法 JSON、缺必填字段、`scheduledEnd <= scheduledStart`、邮箱格式非法、`applicationId` 不属于该画像。
- `401`：未登录。
- `404`：画像不存在，或 `applicationId` 指向的投递不存在。

### `GET /interviews`

列出当前登录账号创建的面试，按 `scheduledStart` 倒序，**只返回本人数据**。

#### Query 参数（均可选）

| 参数 | 说明 |
| --- | --- |
| `profileId` | 仅返回该候选人的面试 |
| `status` | 按状态过滤，取值同 `status` 枚举；非法值 `400` |

#### 响应（200）

```json
{ "items": [ { "id": "int-<uuid>", "profileId": "prof...", "status": "scheduled" } ] }
```

未登录返回 `401`。

### `PATCH /interviews/:id`

改期、状态流转或登记结果。

#### 请求体（至少一个字段）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `status` | enum | 状态流转 |
| `scheduledStart` / `scheduledEnd` | string(ISO8601 datetime) | 改期；与现有值合并后仍须满足 end > start |
| `format` | enum | 调整面试形式 |
| `roundLabel` | string | 轮次说明 |
| `targetTitle` / `targetCompany` | string / string \| null | 岗位信息，公司传 `null` 清空 |
| `interviewerName` / `interviewerEmail` | string \| null | 面试官信息，传 `null` 清空 |
| `outcome` | enum \| null | 面试结论，传 `null` 清空 |
| `rating` | integer 1–5 \| null | 招聘方内部评分，传 `null` 清空 |
| `feedbackNote` | string \| null | 反馈备注，传 `null` 清空 |

#### 响应

- `200`：返回更新后的完整记录。
- `400`：非法 JSON、请求体为空、枚举非法、`rating` 越界、邮箱非法、合并后 `scheduledEnd <= scheduledStart`。
- `401`：未登录。
- `404`：面试不存在，或不属于当前登录账号。

---

## 4. 健康检查

### `GET /health`

无需请求体，用于探活/负载均衡。**浅检查不访问数据库**，只要函数进程存活即返回 `200`（部署平台/负载均衡探活用，避免因 DB 抖动误杀实例）：

```json
{ "status": "ok", "service": "jobagent-api", "time": "2026-09-11T08:00:00.000Z" }
```

### `GET /health?deep=1`（或 `?deep=true`）

**深检查**额外经持久化层执行一次 `SELECT 1` 往返（SQLite/Postgres 方言差异收敛在 storage 层），用于部署后 smoke 与监控区分"进程在但数据库不可达"。

- `200`（DB 可达）：

```json
{ "status": "ok", "service": "jobagent-api", "time": "2026-09-24T08:00:00.000Z", "db": "ok", "dbLatencyMs": 2 }
```

- `503`（DB 不可达）：

```json
{ "status": "error", "service": "jobagent-api", "time": "2026-09-24T08:00:00.000Z", "db": "unreachable", "error": "..." }
```

`tools/smoke-deploy.sh` 同时断言浅检查 `200 {"status":"ok"}` 与深检查 `200 {"db":"ok"}`。

---

## 5. 内部定时端点（serverless 部署，/internal/cron/*）

形态 C（Vercel 单项目同域，见 [deployment-runbook-20260920.md](deployment-runbook-20260920.md)）没有常驻 Worker：Vercel Cron 定时 GET 这两条端点驱动分析消费与数据清理。本地 / Docker 常驻部署不经过它们（常驻 Worker 自行轮询，清理走宿主 cron 调 CLI）。形态 C 下外部路径为 `/api/internal/cron/*`（前缀由转发层剥离，见文首路径约定）。

**鉴权（二选一）**：

1. 配置了 `CRON_SECRET`：请求必须带 `?token=<CRON_SECRET>`，服务端常量时间比较，不符返回 401；
2. 未配置 `CRON_SECRET`：仅接受平台注入的 `x-vercel-cron: 1` 请求头（仅建议临时调试，生产必须配 secret）。

### `GET /internal/cron/process-job`

认领并处理**至多一个** `analysis_job`（复用 worker 的 `claimAndProcessOne`：含 5 分钟僵尸任务回收、demo 并发闸退避、失败重试/永久失败判定）。Vercel 每分钟调一次；队列堆积时靠后续调用逐任务消化。

`200`：

```json
{ "ok": true, "outcome": { "kind": "processed", "jobId": "job-...", "profileId": "prof-..." } }
```

`outcome.kind` 取值：

| kind | 含义 |
| --- | --- |
| `idle` | 当前无可认领任务 |
| `deferred` | 命中 demo 并发闸，任务保留且不烧 attempts，下一轮再认领（带 `jobId`） |
| `processed` | 处理完成并写出画像（带 `jobId`、`profileId`） |
| `failed` | 本次处理失败（带 `jobId`、`permanent`、`message`；永久失败置终态，可重试错误退避） |

`500`：配置错误（如 `GITHUB_TOKEN` 缺失）等异常返回 `{ "ok": false, "error": "..." }`，不伪装成功。

### `GET /internal/cron/cleanup?task=demo|auth|all`

物理清理过期数据，语义与 CLI `jobagent demo cleanup` / `jobagent auth cleanup` 一致；只删会话/限流事件/未认领账号，绝不触碰 `profiles`/`evidence`。`task` 默认 `all`，非法值返回 400。保留窗口：demo/auth 会话与限流事件过期后再留 24h；未认领且无有效会话的账号留 30 天。

`200`：

```json
{
  "ok": true,
  "result": {
    "task": "all",
    "demoSessions": 0,
    "demoRateEvents": 0,
    "authSessions": 0,
    "unclaimedAccounts": 0
  }
}
```

> 岗位库日更 / HN 月更**不走**这两条端点（采集耗时不适合 serverless），由 GitHub Actions 定时跑 CLI `jobs sync`，见 `.github/workflows/jobs-sync.yml` 与 Runbook §7。

---

## 端到端时序

```text
Client                API                 Worker              Storage
  |  POST /analyze      |                     |                   |
  |-------------------->| 查缓存/去重/建任务   |                   |
  |<---- jobId ---------|                     |                   |
  |                     |  claimNext (poll)   |                   |
  |                     |<--------------------|                   |
  |                     |  L0 → L1 采集+分析  |                   |
  |                     |-------------------->| 写 profile/evidence|
  |  GET /jobs/:id (轮询)|                     |                   |
  |-------------------->|                     |                   |
  |<---- running -------|                     |                   |
  |  ...                |                     |                   |
  |<---- succeeded -----|                     |                   |
  |  GET /profiles/:id  |                     |                   |
  |-------------------->|                     |                   |
  |<---- AbilityProfile |                     |                   |
```
