# 触达通道设计（邮件 digest + Web Push）——2026-10-10

> 状态：现行（P0 决策已拍板 2026-10-10，实现中）
> 触发来源：handoff 2026-10-06 条目留下的「真正的主动触达（邮件/Web Push）需外部通道，缓做」；
> 当日用户拍板两个通道都做，并拍板邮件第一期只发用户本人。

## 1. 背景与问题

求职 Agent 的 `*/5` agent-tick 扫出新候选后落在 `awaiting_approval`，用户不打开工作台就不知道
有候选在等确认。2026-10-06 已落地站内未读徽标（`job_runs.last_viewed_at`），但那要求用户
主动回访——「找工作」闭环里唯一会真实丢机会的断点仍在：人不在页面时没有任何外部触达。

## 2. 已拍板决策（2026-10-10）

- **决策 #25：触达通道双落地**——邮件 digest 与 Web Push 都做，同一批落地。
- **决策 #25-1：邮件 digest 第一期只发用户本人**（当前产品只有本人一个真实用户）。
  走 Cloudflare Email Service Workers binding（`send_email`），发信域名 `job-agent.bayjf.com`
  已在 Cloudflare 账号内；Free 计划发送免费、只发已验证目的地址。
  **未来开放给其他登录用户时**，需升级 Workers Paid（$5/月，含 3,000 封/月），
  触发条件与升级动作已记入 docs/deferred-items.md，届时再议，不在本期范围。
- **决策 #25-2：推送是登录态 opt-in、可随时关闭**——默认不开；工作台通知设置里显式开启；
  关闭即删订阅行，绝不留"沉默订阅"。

## 3. 总体形态

两个通道共用同一份「有待确认候选」事实源，各自独立开关：

```text
agent-tick（*/5）扫出新候选 → submit_intents 落 pending
        │
        ├─ Web Push（近实时）：agent-tick 当轮内对该 account 的启用订阅发推送
        │
        └─ 邮件 digest（每日一档）：cron-worker 每日 cron → /internal/cron/digest-tick
             → 聚合各账户"距上次 digest 后新增的 pending 候选" → Email Service 发出
```

分期：

| 期 | 内容 | 外部依赖 |
|---|---|---|
| P0（本期） | 数据层 + 通知偏好 API + Web Push 全链 + 邮件 digest 全链（发信走 Email Service，只发本人已验证地址） | Email Service 域名 onboarding + DKIM（一次性，控制台/CLI） |
| P1（缓做） | 开放给其他登录用户（需 Workers Paid） | 真实多用户出现时 |

## 4. 数据模型（迁移 034）

一张 `notification_subscriptions` 表承载两种通道订阅（一行 = 一个账户在一个通道上的一个订阅端点）：

- `id` TEXT PK（`nsub-<uuid>`）
- `account_id` TEXT NOT NULL → accounts.id（级联删除）
- `channel` TEXT NOT NULL（`'email_digest' | 'web_push'`）
- `endpoint` TEXT NOT NULL——web_push 为 push endpoint URL；email_digest 为目的邮箱地址
- `keys_json` TEXT NULL——web_push 的 `{p256dh, auth}`；email_digest 恒 NULL
- `enabled` INTEGER NOT NULL DEFAULT 1（opt-in 开启；关闭即整行删除，enabled 仅为防御性闸）
- `last_sent_at` TEXT NULL——该订阅上次成功触达时刻（邮件 digest 用于"距上次后新增"窗口；
  web push 每次匹配即推、不依赖窗口，仅作观测）
- `created_at` / `updated_at`
- UNIQUE(`account_id`, `channel`, `endpoint`)

不建 `notification_prefs` 单独表：开关语义＝行的存在性（有行＝开，删行＝关），避免两处事实源漂移。

## 5. API 面（全部登录 user 态、本人归属闸）

- `GET /agent/notifications` → 本人全部订阅（email/web_push 投影，keys 不回发）
- `PUT /agent/notifications/email-digest` `{ email?, enabled }`——开启：目的地址取入参或 accounts.email
  （GitHub 公开邮箱可能为空 → 为空时 400 要求显式给 email）；关闭：删行
- `POST /agent/notifications/web-push` `{ endpoint, keys:{p256dh,auth} }`——upsert 订阅
- `DELETE /agent/notifications/web-push` `{ endpoint }`——删订阅
- `GET /agent/notifications/vapid-key` → 应用服务器公钥（env `VAPID_PUBLIC_KEY`，未配则 503）

内部 cron：

- `GET /internal/cron/digest-tick`（cronAuthorized）：聚合每个 email_digest 订阅自 `last_sent_at`
  （缺省 24h）以来该账户新增的 pending submit_intents，逐订阅产出一封 digest 载荷
  `{ subscriptionId, to, subject, text, html }` 列表返回，由 cron-worker 用 Email binding 实际发送，
  发送成功后回调 `POST /internal/cron/digest-sent { subscriptionIds[] }` 回写 `last_sent_at`。
  零候选的订阅不产信、也不回写窗口（避免"空窗推进"导致下一封漏掉期间候选——窗口只在真正发出时推进）。
- 心跳消费方名 `digest-tick`，与既有 cron_heartbeat 同轨。

Web Push 触发点：agent-tick 一轮内某 run 从非 awaiting 进入 `awaiting_approval`（即有新 pending
候选）后，对该 account 的启用 web_push 订阅逐个发送（payload：run 标题+候选数+工作台深链）；
失败 404/410 的订阅即刻删除（端点已失效）。发送失败不阻塞 tick 主流程、不记 run 失败。

## 6. Web Push 技术选型

- 推送协议用标准 Web Push（VAPID），浏览器侧 `PushManager.subscribe`；Service Worker 用报告页
  新加的 `public/push-sw.js`（最小壳：push → showNotification；notificationclick → 打开/聚焦工作台）。
- 服务端发送库：`web-push`（Node，API 侧 Vercel serverless 可跑）。VAPID 密钥对一次性生成，
  公钥入 `VAPID_PUBLIC_KEY`（report 构建期与 API 共用），私钥入 `VAPID_PRIVATE_KEY`（API env only）。
- 此前 spike（gitignored `data/spike-web-push/`）已验证 SW 注册 + 订阅链路可行。

## 7. 邮件 digest 技术选型

- 发送：cron-worker 加 `send_email` binding（`EMAIL`），`wrangler email sending enable job-agent.bayjf.com`
  完成域名 onboarding + DKIM（一次性人工/CLI 步骤，记 handoff）。
- 频次：每日一档（cron-worker 加第三条 cron，如 `0 1 * * *` UTC = 09:00 CST）。
- 成本硬约束：只发已验证目的地址；第一期收件人＝用户本人（决策 #25-1）。
- 文案本期统一中英并列一段（账户无语言列，沿落地页惯例）。

## 8. 前端（工作台）

`/[locale]/workbench` 新增「通知设置」卡（登录态可见）：

- 邮件 digest 开关 + 目的邮箱输入/展示；
- Web Push 开关：开 → 注册 SW + `PushManager.subscribe` + POST 订阅；关 → unsubscribe + DELETE；
- 浏览器拒绝授权（Notification.permission === 'denied'）时如实展示"浏览器已拒绝"态，不假装成功。
- 全部文案走 t() 中英双语 key。

## 9. 硬约束（沿用项目铁律）

- 业务只依赖 storage 仓储接口；sqlite/postgres 双方言迁移编号对齐（034）。
- 推送/发信失败绝不阻塞 agent-tick / digest-tick 主流程，绝不让"通知挂了"变成"任务失败"。
- 订阅是私有数据：全部端点本人归属闸，匿名 401、非本人 404。
- VAPID 私钥、邮箱目的地址不出现在任何对外响应（邮箱仅本人 GET 可见）。
- 文案 i18n 一致性测试同步加 key。

## 10. 健康告警兜底（2026-10-10 增补，闭环 deferred「Cron Worker 失败信号无读者」）

候选通知是"有新结果"通道，但 **cron 消费方死了**是另一类更需要人知道的事。两个通道补兜底：

- **watch-heartbeat 边沿推送**：`GET /internal/cron/watch-heartbeat`（`apps/api/src/routes/system.ts`）判 stale
  （`WATCHDOG_STALE_THRESHOLDS`：agent-tick 15min / process-job 30min / digest-tick 25h）时，在**翻转边沿**
  （上轮健康→本轮 stale）向全部启用的 `web_push` 订阅推一条告警（复用 `web-push.ts` `sendWebPush`：
  gone 删行、ok markSent、失败不抛不阻塞 tick）。**防抖**＝比较 watchdog 行自身 `lastError`：与本次 stale
  消息相同 ⇒ 上轮已告警、跳过；为空（健康轮后）或不同 ⇒ 新事件、推。
- **digest 每日兜底**：`GET /internal/cron/digest-tick`（`apps/api/src/routes/notifications.ts`）聚合时读
  `cronHeartbeat.listAll()` + 同阈值判 stale——零候选时产一封**纯告警信**；有候选时正文顶部加告警段。
  保证 Web Push 没开/没人看时，每日邮件仍能让人知道系统不健康。
- **注入面**：`ApiDeps.sendWebPush?: typeof import('../web-push.js').sendWebPush`（不传默认用真实现；
  VAPID 未配置返回 [] 天然降级）；`RouteDeps` 必填 `sendWebPush`；`index.ts` 装配。
- **无新表、零迁移**（复用 `cron_heartbeat` 与 `notification_subscriptions`）。
- **边界**：告警依赖真实订阅开启（当前唯一真实用户＝owner，已开 email_digest）；平台对接类自动告警
  （企业微信/飞书机器人）不在本期，见 deferred 该条。
