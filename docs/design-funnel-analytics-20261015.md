# 产品验证漏斗埋点设计（funnel_events）

> 日期：2026-10-15
> 状态：**现行（Wave A–E 已落地）**
> 关联：[PRD.md](PRD.md) §11.2「MVP 验证漏斗」、§9 NFR-7「可观测」、R4；成本计量 [design-cost-metering-20261014.md](design-cost-metering-20261014.md)（`usage_events`，只记成本、不记产品行为，本表与其互补不重叠）
> 迁移：040（sqlite/postgres 对称）

## 1. 背景与目标

PRD §11.2 要求用「落地页真实埋点」回答验证漏斗：

```
输入用户名 → 分析成功率 → 报告完整查看率 → 分享 / 留资转化率
```

到 2026-10-15 为止这条漏斗没有任何数据：`usage_events`（迁移 038）只回答"哪个功能在烧钱"（token / 次数），不回答"用户走到哪一步"；分析成功率虽可从 `analysis_jobs` 终态直接统计，但前三步之间的转化（触发→看报告→分享）完全没有观测面。

本设计以**最小自建事件日志**补齐，目标读数（CLI 即可回答，不做实时看板）：

1. 一段时间内有多少次"触发新分析"、多少次"缓存命中"（漏斗起点 + 缓存价值）；
2. 多少个匿名会话看了报告、其中多少会话点了分享（北极星 §11.1 的代理指标）；
3. 上述按自然日的趋势。

## 2. 硬约束（隐私与工程）

1. **不引第三方分析服务**（PostHGA / Plausible / GA 等一律不接）：无外部脚本、无数据出境给分析厂商，隐私政策只需要声明"我们自己记匿名统计"。
2. **不记个人数据**：不记账号 id、不记 IP、**不记被分析的用户名 / 平台主体 login**、不记 UA。
3. **会话串联只用一次性随机标识**：报告页 SSR 给浏览器种 `ja_sid`（随机 UUID，`Max-Age=86400`，`HttpOnly`、`SameSite=Lax`、`Path=/`），24h 后自然失效；它不与账号、不与 demo 会话、不与 IP 哈希做任何 join。
4. **埋点 fail-open**：任何埋点写入失败只进服务端日志，绝不阻断报告页渲染、`/analyze` 与分享点击（与 `usage_events` recorder 同一纪律）。
5. **客户端只能上报 `share_clicked` 一个事件**；另外三类是服务端事件，公开端点拒绝写入，防止伪造污染漏斗。
6. 表只追加（append-only），无 UPDATE/DELETE 仓储口。

## 3. 事件清单

| event | 谁写 | 触发点 | session_ref | profile_id | requester |
| --- | --- | --- | --- | --- | --- |
| `analyze_enqueued` | API | `POST /analyze` **新建** analysis_jobs 成功后（user/demo 各一处；active 去重复用、配额拦截、REMOVAL_PENDING 均**不**记） | 读 `ja_sid`，无则 NULL | NULL | `user` / `demo` |
| `analyze_cache_hit` | API | `POST /analyze` 命中未过期 complete 画像直接返回时 | 同上 | NULL | 不区分（NULL） |
| `report_viewed` | 报告页 SSR | `/[locale]/report/[profileId]` 成功加载（非 redirect）后 | SSR 读/种 `ja_sid`，必有值 | 报告画像 id | `user`（登录 user）/ `visitor`（匿名/demo） |
| `share_clicked` | API（前端回传） | 报告页分享按钮点按，`POST /funnel/events` | 读 `ja_sid`，无则 NULL | body 可空 profileId（Zod 校验为 uuid 形态，非 uuid 拒绝） | NULL |

说明：

- `analyze_*` 不记 `platform`（github/gitee/all）与 login：漏斗只数次数，分平台读数不在 v1 范围，避免任何主体标识落表。
- `report_viewed.requester` 的 `user` 判据＝报告页 `resolveViewer` 解析出的登录 user（与 `canViewGated` 同源），不记账号 id。
- 分析成功率（漏斗第二步）**不埋点**：直接以 `analysis_jobs.status` 终态（succeeded/failed/partial）统计，单一事实源，避免双份口径漂移。
- 留资（漏斗第四步）继续以 `waitlist` 表与落地页仓为准，本期不打通跨仓事件。

## 4. 数据模型（迁移 040）

```sql
CREATE TABLE funnel_events (
  id           TEXT PRIMARY KEY,            -- fe-<uuid>
  event        TEXT NOT NULL,               -- 4 值枚举，应用侧 Zod 守门，DB 无 CHECK
  session_ref  TEXT,                        -- ja_sid（24h 随机），非浏览器来源为 NULL
  profile_id   TEXT,                        -- 仅 report_viewed / share_clicked
  requester    TEXT,                        -- user | demo | visitor；不适用 NULL
  created_at   TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)  -- UTC ISO8601
);
-- 索引：时间窗读数、会话去重查询、(event, profile) 转化查询
```

- 无外键（刻意不级联账号 / 画像删除以外的东西；画像被撤回删除后事件作为聚合计数保留，且不含主体标识）。
- 方言纪律与 038 一致：时间列两方言都用 TEXT ISO8601，PG 比较走 `time-text.ts` 的 `tsGte/tsLt`。
- 进 `REQUIRED_COLUMNS`：`{ table: 'funnel_events', column: 'event' }`——fail-open 缺表会**静默失盲**，必须让 `/health?deep=1` 503 显式暴露。

## 5. 写点与去重

### 5.1 报告页 SSR（report_viewed）

- 位置：`apps/report/src/pages/[locale]/report/[profileId].astro` frontmatter，`loadReportPageData` 返回 `kind: 'ok'` 之后；逻辑放 `apps/report/src/lib/funnel.ts`（可单测），页面只调一行。
- sid：`Astro.cookies.get('ja_sid')`，缺失则 `randomUUID()` 新种（`httpOnly/sameSite:'lax'/path:'/'/maxAge:60*60*24`）。
- 去重：仓储 `recordView` 内查最近 30 分钟是否已有同 `(session_ref, profile_id, 'report_viewed')`，有则不插（刷新/翻锚点不重复计数）。sid 为 NULL 不去重（bots/异常流量在分析时单独看 NULL 组占比）。
- 存储：`getWritableStorage()`（只读单例不写）；写入 await 但包 try/catch，失败 console.error。

### 5.2 /analyze（analyze_enqueued / analyze_cache_hit）

- recorder 经 `RouteDeps.funnelRecorder` 注入（与 `usageRecorder` 同模式，`createFunnelRecorder(repos.funnelEvents)` + `createNullFunnelRecorder()`）。
- 缓存命中分支记 `analyze_cache_hit`；两个 `jobs.create` 成功之后记 `analyze_enqueued`（demo 补偿失败抛错时不记）。
- `session_ref` 用 `readCookie(c.req.header('cookie'), 'ja_sid')` 读取；落地页跨子域 POST 在 SameSite=Lax + same-site（同 eTLD+1）下会带该 cookie，不带也合法（NULL）。

### 5.3 POST /funnel/events（share_clicked）

- 公开端点（无身份闸），Zod body：`{ event: z.literal('share_clicked'), profileId?: uuid }`，其他 event 一律 400。
- 限流：复用 demo IP 滑窗表（`demo_ip_windows`，bucket 新增 `'funnel'`，无迁移）：每可信 IP 60 次/小时，超限 429；无可信 IP（本地/代理后）不拦，靠端点只写一条 share 事件 + 30 分钟 `(session, profile)` 去重兜底。
- 成功 202，**永不返回埋点内部错误给前端**（失败 202 + 日志，fail-open 到响应层）。
- 前端：`ShareButton.tsx` 加 `apiBase` prop，复制成功后 fire-and-forget POST（`keepalive: true`），不 await、不提示、不影响复制行为。

## 6. 读口（CLI，不建 HTTP 路由）

```
jobagent funnel summary --since <ISO> [--until <ISO>] [--format json|table]
  # 输出：每个 event 的次数、去重会话数（COUNT(DISTINCT session_ref)）、NULL 会话数
jobagent funnel daily --since <ISO> [--until <ISO>] [--format json|table]
  # 输出：自然日(UTC) × event 次数
```

运营工具无身份闸（与 `usage` 命令一致）。v1 不做 admin 页面、不做实时看板；读数需求固定后再谈表面。

## 7. 测试计划

- **storage**：`funnel-events.test.ts`（SQLite 内存；insert/summary/daily/30 分钟去重/NULL 组）；`postgres-behavior.test.ts` 加 1 例（有 `DATABASE_TEST_URL` 时实跑，行主键随机后缀，遵守连跑纪律）。
- **迁移**：`migrations.test.ts` 自动覆盖表存在；`check-migrations.sh` 校编号对齐。
- **API**：`/analyze` 三分支断言（新建 user/demo 各恰好一条 `analyze_enqueued`、缓存命中一条 `analyze_cache_hit`、去重/配额拦截零条）；`POST /funnel/events`（合法 202、非法 event 400、非 uuid profileId 400、伪造其余三类事件 400、超限 429、fail-open：仓储抛错仍 202）。
- **报告页**：`lib/funnel.ts` 单测（sid 生成/复用、去重窗口、fail-open）；mock 版报告 E2E 加一条断言：首次打开报告页响应带 `Set-Cookie: ja_sid=...`。
- **隐私反证**：单测断言四类事件的入参/行内不存在 login/username/ip/accountId 字段（schema 层就没有这些列）。

## 8. 部署顺序

按 B5：**先在生产 Supabase 执行 040（postgres 迁移）→ 实查列在 → 再合 dev→main**。合并后 `/health?deep=1` 的 `funnel_events/event` 列校验生效；未执行迁移前深探活会 503（这正是守卫目的）。无新 env、无新 secret、无第三方依赖。

## 9. 明确不做（v1 边界）

- 不接第三方分析、不做前端 SDK 式通用埋点框架（只有 4 个硬编码事件）。
- 不记浏览器 UA / referer / 屏幕 / 地域；不做跨设备身份拼接。
- 不做实时看板与 admin 页面；不做告警阈值（漏斗是人工定期读数，不是看门狗）。
- 不做事件保留/清理任务（表增长后再按触发条件立项；单事件 ~120 字节，日万级约 40MB/年）。
- 不打通落地页仓与 waitlist 的跨仓漏斗（留资数人工对账）。
