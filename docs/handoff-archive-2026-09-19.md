# Handoff 历史归档（截至 2026-09-19）

> 本文件为 [handoff.md](../handoff.md) 的历史归档。按归档惯例（对齐 agent-world：主文件只保留「项目当前状态 + 活跃任务 + 最近 5 条变更 + 文档索引」；编号待办标 ✅ 后详细过程整块滚入归档、主文件只留一行结论 + commit hash），2026-09-19 从主文件移出以下内容。**只读、不再追加**；新变更直接写主文件，主文件同步态以此为准。

## 1. item28 本人授权主脊（GitHub OAuth 登录 + accounts/auth_sessions + 本人认领）明细

> 决策 #1-A / #6-A。后端主体于 2026-09-18 落地为 5 个英文原子提交并已 push（基线 `9a48761`，经 PR 并入路径以主 handoff Git 状态为准）；其前端接线与运维清理本体在 item29（见本文件 §2）补齐。

分层落地（5 提交）：

1. `53072c3` feat(shared)：把长期预留、从未产生的 `Principal.kind='user'` 接上真实登录来源。user Principal 扩为 `{kind:'user',accountId,sessionId,platform,login,expiresAt}`；新增 cookie 常量 `jobagent_session`（HttpOnly，`AUTH_SESSION_COOKIE`）、`jobagent_oauth_state`（CSRF，Path=/auth/github）；`AuthMeSchema`（**刻意剥离 email/providerAccountId**，有测试断言）、`ClaimResultSchema`、`AUTH_ERROR_CODES`（401/403/404/400/501/502）。auth-account 9 测试。
2. `5ff8c9c` feat(db)：双方言迁移 010 `accounts`（UNIQUE(platform,provider_account_id) 等 3 索引）、011 `auth_sessions`（account/expires 索引），一文件一表、sqlite/pg 对称，check-migrations 11 对 0 warning。
3. `0cc4fa3` feat(storage)：两实体 + `IAccountsRepository`（upsertFromProvider/getById/getByProvider/setClaimedProfile）+ `IAuthSessionsRepository`（create/getActive/touch/revoke）+ profiles 双方言 `markClaimed`，StorageContext/createStorage 双方言装配。accounts-auth-sessions 9 测试，schema-parity/migrations/PG-behavior 同步（PG 迁移计数 9→11、真实 embedded Postgres 7/7）。
4. `5dfa0b3` feat(api)：auth-config 纯函数 + AuthProvider 端口 + github-auth（Node24 全局 fetch web flow、HMAC-SHA256 签名 state + timingSafeEqual 校验、scope=user:email）+ FakeAuthProvider（测试不打网络）+ `resolveAuthPrincipal`（**user 优先于 demo/匿名**）。5 端点：`GET /auth/github/login`（未配置 501 AUTH_NOT_CONFIGURED）、`GET /auth/github/callback`、`POST /auth/logout`（匿名 no-op）、`GET /auth/me`、`POST /profiles/:id/claim`。claim 校验画像 subject 与登录账号 platform+login **完全一致**（非本人 403 AUTH_NOT_PROFILE_OWNER、画像不存在 404、匿名 401、幂等重复 200）。登录用户 `/analyze` 建 `requesterKind=user`/`demoSessionId=null` 任务、不占 demo 配额（worker 仅对 demo 做并发闸、formal 优先，user 天然通行，无需改 worker）。auth 9 + auth-flow 8 测试，api 共 106 全绿。
5. `0f4ce17` docs(api)：`.env.example` 加 OAuth 段、`docs/API.md` 新增 §1.2（5 端点 / 两类 cookie / 错误码 / claim 归属规则 / 登录用户 analyze 路径）+ 状态码表 / 环境变量表。

AuthMe 返回约定：匿名/演示只回 `{kind}`；user 回 `{kind:'user',accountId,platform('github'|'gitee'),login,name?,avatarUrl?,claimedProfileId?,expiresAt?}`，**不回 email/providerAccountId**。OAuth env（外部未配）：`GITHUB_OAUTH_CLIENT_ID/SECRET`、`AUTH_STATE_SECRET`、`AUTH_CALLBACK_BASE_URL`、`AUTH_AFTER_LOGIN_URL`（默认 '/'）、`AUTH_SESSION_TTL_MS`。

## 2. item29 账号主脊前端接线 + 认证数据运维清理（2026-09-19，3 个代码原子提交）

> 用户拍板「搞 1 和 2」：①把已落地的认证后端接到报告页前端（item28-⑤）；②照 `demo cleanup` 给 CLI 加 `auth cleanup`（item28-④ 本体，cron 调度随部署）。**未授权**「授权分级闸（未登录看他人画像折叠哪些模块）」，本批不做。3 个代码提交：`d88328a` feat(db) → `c6492ab` feat(cli) → `a914500` feat(report)；文档随末个 docs 提交。

### 2.1 storage 清理方法（`d88328a`，双方言）

- `IAuthSessionsRepository.purgeExpired(nowIso, retainMs)`：删 `(status='revoked' AND last_seen_at<cutoff) OR expires_at<cutoff`，cutoff = now − retainMs。
- `IAccountsRepository.deleteUnclaimed(nowIso, retainMs)`：删 `claimed_profile_id IS NULL AND updated_at<cutoff AND NOT EXISTS(select 1 from auth_sessions where account_id=accounts.id and expires_at>=now)`。再次登录会按 (platform, provider_account_id) 重新 upsert，故删无认领记录的闲置账号不丢数据。
- 方言差异只在计数返回：sqlite `.delete().run().changes ?? 0`；postgres `.delete().returning({id}).length`。NOT EXISTS 用物理表/列名 snake_case 内联 `sql\`\``，sqlite/pg 物理命名一致故双方言通用。
- `accounts-auth-sessions.test.ts` 新增两个 describe（purgeExpired / deleteUnclaimed），用原始 INSERT 精确控制时间戳，确定性验证「删过期/撤销 + 陈旧未认领；留 active、近期撤销、已认领、有活会话、近期更新」，文件 11 测试全绿。PG 行为套件本就只覆盖迁移/并发、无账号 CRUD 用例，新 PG 方法沿用「sqlite 逻辑测试 + PG typecheck + 标准 Drizzle/标准 SQL」既有覆盖口径。

### 2.2 CLI `auth cleanup`（`c6492ab`）

- 新建 `apps/cli/src/auth-commands.ts`：`jobagent auth cleanup [--retain-hours 24] [--account-retain-hours 720]`，先清会话再清账号（顺序保证 NOT EXISTS 反映清理后状态）。默认会话保留 24h（与 demo cleanup 一致）、未认领账号保留 30 天（720h，避免删掉刚登录未认领的用户）。输出 `purged N expired/revoked auth session(s) (retain Xh) and M unclaimed account(s) ... (retain Yh)`。退出码 0 成功 / 2 参数错 / 1 存储错。DB 走 deps.storage 或 `DB_PATH ?? data/job-agent.db`（makeCliStorage）。
- `index.ts` 注册 `command==='auth'` → runAuth，并在根 Usage 加 `auth cleanup`。
- `auth-commands.test.ts` 5 测试（固定未来 NOW=2027-06-01 保证确定性：清理计数 / 保留 claimed 与 live-session / 账号保留窗 / 两个非法 flag 退出 2 / 未知子命令退出 2），全绿。
- cron 调度本体不做，随生产部署挂定时任务（与 `demo cleanup` 同等待遇，见 deferred）。

### 2.3 报告页登录/认领前端（`a914500`）

照 DemoBanner / ShareButton 范式（fetch `${apiBase}/...`、`credentials:'same-origin'`、文案全由 Astro props 经 t() 传入、只用 `--ja-*` token、`client:load`）新建两个 React island：

- **AccountMenu.tsx**（挂 Layout 全局头部 nav）：拉 `/auth/me`；匿名/demo 显示「用 GitHub 登录」整页跳 `${apiBase}/auth/github/login`；user 显示头像 + name/login + 退出按钮（POST /auth/logout 后 reload）；拉取失败渲染 null（fail-closed，无后端环境不留坏入口）。根元素用 `<div role="navigation">` 避免 nav 嵌 nav。
- **ClaimProfile.tsx**（挂报告页 header-meta，仅 SSR `claimed=false` 且非融合画像时）：拉 /auth/me，仅当 user 且 platform+login 与画像主体完全一致显示「认领此画像」→ POST claim → 成功本地切「本人已验证」徽章（不 reload，便于 E2E 断言）；claimedProfileId 已命中也显徽章；401/403 收起、其他错误显可重试错误态；匿名/演示/非本人不渲染（**不做授权分级折叠**）。`.astro` 在 claimed=true 时 SSR 直接渲染 owner 徽章（无 JS）。
- i18n 两字典各加 8 key（zh 先 en 后，en 全覆盖 MessageKey）：`account.menuLabel`、`account.signInGithub`、`account.signOut`、`report.claimedBadge`、`report.claim.cta`、`report.claim.claiming`、`report.claim.error`、`report.claim.hint`。
- global.css 加 `.ja-badge--owner`（success token）与 account-menu / claim-profile 样式（头像圆形用 50%——radius token 只有 sm/md/lg 无 full/pill；全用 token、无 hex、无带 fallback 的 var）。
- 新建 `e2e/account-auth.spec.ts`（6 用例，全 `page.route` mock、零真实 OAuth）：匿名显登录链接、user 显身份+退出回匿名、本人认领成功出徽章、非本人/匿名隐藏 CTA、已认领 SSR 显徽章。

### 2.4 扩展面板评估结论：不适用、不改码

`apps/extension` 是注入第三方 ATS 域的 content script + Shadow DOM 只读消费者（lib/api.ts 只调公开 analyze/exportable/match，不写数据）；OAuth 重定向流与 HttpOnly cookie（作用在 API/report 域）在 content script 场景不适用。且 `panel.tsx` 已在 `profile.subject.claimed` 为真时渲染 `t('panel.claimedBadge')` 认领徽章。故扩展不加登录/认领入口——**登录认领是报告站点能力**，本结论只记文档、不改扩展代码。

### 2.5 验证（Node v24.0.0，fnm）

- 针对性：storage 113 单测（含新增清理用例）、cli 57（+5）、report 单测 28（含 i18n key 对齐 22）、report `astro build` Done、account-auth E2E 6/6。
- 全仓门禁：`pnpm -r typecheck` / `pnpm -r test`（**712 单测全过**，13 包）/ `pnpm -r build` 全 Done、`bash tools/check-migrations.sh` 11 对 0 warning、`git diff --check` 干净；**报告 Playwright E2E 43/43 通过（41.5s，原 37 + 新 6）**，全局 AccountMenu 无回归。
- 真实浏览器复验（内置浏览器，本地起 API 3000 + report 4321，DB 指向含真实画像的 data/job-agent.db）：首页与报告页头部均出现「用 GitHub 登录」（链接指向 API `/auth/github/login`）；匿名报告页（bayernjf `c640d2d2`，未认领）不出现认领按钮/徽章、控制台无报错；未配 OAuth 时 `/auth/github/login` 返回 501（符合预期）。本人态/认领/退出交互由 6 个零网络 E2E 在真实 Chromium 覆盖（真实 OAuth 联调属外部项）。

### 2.6 明确未做（边界 / 外部项）

- 真实 GitHub OAuth App 凭证 / `AUTH_STATE_SECRET` / 回调域名：外部项，测试用 FakeAuthProvider 不阻塞。
- **授权分级闸**（未授权浏览他人画像折叠哪些重模块）：用户未授权，范围待讨论，记 deferred。
- OAuth 登录后 `return_to` 深链回跳：后端 `AUTH_AFTER_LOGIN_URL` 默认 '/'，逐请求回跳需同源 allow-list 防开放重定向，记 deferred。
- Gitee OAuth、认证态精确限频：随双源节奏后续。
- `auth cleanup` / `demo cleanup` 的生产 cron 调度：随部署补。
