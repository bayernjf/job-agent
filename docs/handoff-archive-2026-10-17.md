# Handoff 历史归档（2026-10-17）

> 归档惯例（对齐 agent-world，2026-09-18 起执行）：主文件只保留「项目当前状态 + 活跃任务 + 最近变更 + 文档索引」；编号待办标 ✅ 后，详细过程（实现步骤 / commit 链 / 踩坑 / 验证数据）整块滚入本类文档，主文件只留**一行结论 + commit hash**。归档文件冻结只读、不再追加。
> 本归档对应：handoff「活跃待办」item165 明细（此前"暂留本行，下一归档日滚入"）+ 被「最近 5 条变更」限额挤出的 2026-10-14 流水 + 2026-10-17 生产体检与触发条件实查结论。

## §1 item165 验证漏斗埋点（PRD §11.2 / NFR-7，2026-10-15 落地，10-16 生产执行）

- **目标**：验证漏斗四事件埋点，收口 PRD §11.2 与 NFR-7 的"无数据"空白——`analyze_enqueued` / `analyze_cache_hit` / `report_viewed` / `share_clicked`。
- **数据模型**：`funnel_events`（迁移 040 双方言，append-only 事件日志）；串联键＝24h HttpOnly Cookie `ja_sid`（`SameSite=Lax`，首次查看报告页时种）；**绝不 join 账号/demo/IP**（隐私硬边界）。
- **写点**：
  - `analyze_enqueued` / `analyze_cache_hit`：`/analyze` 服务端自记（入队 / 缓存命中两类）；
  - `report_viewed`：报告页 SSR 记（30 分钟 (session,profile) 去重）；
  - `share_clicked`：公开端点 `POST /funnel/events`（白名单只收该类，复用 `demo_ip_windows` 限流桶 `'funnel'` 60/h，零迁移）。
- **fail-open**：recorder 吞错只记服务端日志，埋点绝不打挂业务。
- **读口**：CLI `funnel summary|daily --since <ISO>`（table/json），**无在线读 API**（刻意）。
- **守卫**：`{funnel_events, event}` 进 `REQUIRED_COLUMNS`（缺列 `/health?deep=1` 503）；隐私政策双语新增 1.7 小节 + lastUpdated 2026-10-15（markdown 权威源与 astro 页同步）。
- **设计/API 登记**：`docs/design-funnel-analytics-20261015.md`；API.md §3.13。
- **验证**：storage 双方言 / api 7 / report lib 4 / CLI 8 / E2E ja_sid Set-Cookie 1 全绿。
- **commit 链**：`2b1c8c9`(shared 契约) → `4230917`(storage 040) → `718eb58`(api) → `f554452`(report) → `1b7ef65`(cli) → `912da7e`(privacy) → `cae9009`(docs) → `c55a388`(ci) → `b102c42`(docs handoff)；PR #179 合并（含同批 ATS detect 顺序修复 + 真实 DOM 回归框架）。
- **生产执行**：迁移 040 于 2026-10-16 由 `pnpm migrate:pg:up` 执行，同批补执行 039（B3-b 批次早前漏执行的账本行；039/040 均幂等）。⚠️ **B5 顺序实际颠倒**：PR #179 于 10-16 01:42 自动合并、先于迁移落地；期间漏斗事件因 fail-open 静默丢弃，无用户面报错。深探活复核（10-17）schemaDrift null、心跳全新鲜 ⇒ 无漂移。

## §2 被「最近 5 条变更」限额挤出的 2026-10-14 流水

### §2.1 B4 例行备份完成＋分段备份法定型（2026-10-14）

- `tools/backup-db.sh` 的 naive 单文件路径在当前生产库**必死**：Supabase `statement_timeout=2min` + 池化器有效吞吐仅 ~15–25KB/s，COPY `job_postings`（15MB/15260 行，全库唯一大表）需 >2 分钟；两种死法交替：池化器掐流 `SSL connection has been closed unexpectedly` / 服务端 `canceling statement due to statement timeout`（与 docker/本机网络无关；`PGOPTIONS=-c statement_timeout=0` 只让流在 ~2.2MB 处 wedged 挂死；IPv6 直连主机仅 AAAA 而本机无 IPv6）。
- **分段法**：①主转储 `pg_dump --exclude-table-data=public.job_postings`（schema+其余全表数据）；②`job_postings` 按 TEXT `id` 字典序键集分块 `\copy` CSV——每块独立 docker `postgres:17-alpine` psql 连接、**前置边界查询**定行数与边界 id（description 内嵌换行，`wc -l`/`tail` 数 CSV 必错）、500 行/块（2000 行恰撞 2 分钟死线）、state 文件断点续跑、**不给分块加 `statement_timeout=0`**（保留服务端超时当 wedge-killer）。
- 脚本：`backups/ja-chunk-dump.sh`（gitignored），恢复＝`pg_restore` 主转储 + 按 seg 序 `COPY job_postings FROM STDIN WITH (FORMAT csv, NULL '\N')`。
- 产物：`backup-20261014-203320-main.dump`（504K）+ `jp-20261014-203320-seg01..25.csv.gz`（~30MB），**15260 行与生产 `count(*)` 实查一致**、25 个 gzip 完整性全过。
- **fuzzy 性质**：键集分块对并发写入非一致性快照（cron 每 5 分钟插新岗位，边界窗口内 id≤边界的新行理论可丢；岗位池日更重采自愈，DR 可接受）。

### §2.2 用量读侧 UI（决策 #25 ④ / design-cost-metering-20261014 §7 Wave D，2026-10-14）

- 闭环 cost-metering「只接了 JSON 端点与 CLI、报告页/工作台用量表面未接」。
- 新增报告页 `/[locale]/usage`：SSR 身份判定（匿名走 `GateCard`）+ 客户端 `UsagePanel` island，调用 `/account/usage`（本人窗口聚合）与 `/admin/usage`（全平台，仅管理员，非管理员 403 静默降级）；默认 30 天窗口、可选截止时间。
- 零硬编码文案（`createTranslator`）、只读、无写操作；i18n 双边各 +33 键（`usage.*` + `nav.usage`），全局导航加入口。
- 测试：`UsagePanel.test.tsx` 3/3；`tsc --noEmit` 干净；i18n key 集 parity 22/22。
- 生产前置：迁移 038 已于 2026-10-14 生产执行并实查确认（三处都在）。

### §2.3 报告页 TOC 增量修补批次（2026-10-14，4 提交链 `c06205f`→`314af07`→`4f75dd8`→`7a4073f`）

- 10-10 PR #158 合并的章节锚点导航之上遗留一撮未提交 WIP（TOC 五文件），清查后定性为增量修补并收口。
- 两处真实修复：① interview 锚点此前对匿名用户也渲染（点了撞 401 区块），现按 `canViewGated` 与章节渲染同口径隐藏；② scroll-spy 瞬跳误判——`threshold: 0` 下**边缘零面积相切也算 intersecting**，`window.scrollTo` 直达时上一章节底边恰搭判定带顶、与新章节同批派发，旧逻辑「取 top 最小」必选中上一章（reduced-motion 用户必现），`ReportToc` 改为「顶边进带（72 ≤ top ≤ 40% 视口高）者优先、无则回落全体相交、再取 top 最小」。
- 另补：锚点平滑滚动（reduced-motion 回落 auto）+ scroll-margin 清单补登 L3 `section-semantic`。
- 测试：单测 8/8（+2 钉住瞬跳与超高章节回落）、E2E 108/108（+2：非点击滚动高亮、<960px TOC 隐藏且无横向溢出）、extension E2E 11/11、`git diff --check` 干净。

## §3 2026-10-17 生产体检与触发条件实查（只读核查记录）

> 执行：`curl /api/health?deep=1` + 临时只读脚本连生产 PG（`/tmp/ja-prod-audit.cjs`，仅 SELECT；DATABASE_URL 取自 `.env`，值带引号需 strip——已修正）。本记录影响后续判断：**deferred 触发条件实查结论全部未到线，无需重启任何缓做项**。

### §3.1 生产健康体检（/health?deep=1）

- `status: ok`、`db: ok`、dbLatency 190ms。
- 5 个消费方心跳全部新鲜（UTC 16:25 档）：`agent-tick`（advanced=0,recycled=0）、`digest-tick`（digests=0）、`process-job`（idle）、`search-tick`（advanced=0,failed=0）、`watchdog`（五方全 ok）。
- **无 schemaDrift** ⇒ 迁移 039/040 生产执行后零漂移（B5 顺序颠倒未造成影响）。

### §3.2 触发条件实查（生产库只读）

| 项 | 实查值 | 触发线 | 结论 |
|---|---|---|---|
| profiles complete | **5** | B1-b 过滤下推＝>1000 | 差两个数量级，**不立项维持** |
| profiles partial | 2 | — | 正常 |
| accounts 招聘方声明（recruiter_declared_at） | **0**（accounts 共 2） | S1 闸升级 / B 端组织席位＝≥2 | 未到，维持 |
| applications 总数 | **0**（带结果也 0） | 复盘回写＝≥20 条带结果 | 未到，维持 |
| job_postings active | **13434**（inactive 2360） | — | 较 10-09（13242）持续增长，日更正常 |
| job_runs | **2 条 awaiting_approval** | — | 工作台有真实待确认投递，等用户本人动作（决策 #20 永久边界） |
| funnel_events | **0** | — | 埋点刚上线（10-16 迁移+合并），观察项：持续 0 需复查写点 |
| usage_events | **0** | — | 迁移 038（10-14）以来无 LLM 成功调用/作业终态/websearch 埋点；观察项 |

### §3.3 观察项

1. **funnel_events / usage_events 为 0**：两套埋点上线后均无数据。funnel 属预期（040 刚执行、且需要真实访问触发）；usage 需留意——若后续有 LLM 求职信/分析作业却仍为 0，说明写点链路有断点，届时优先查 `onUsage` 观察者与作业终态埋点。
2. **job_runs 2 条 awaiting_approval**：真实待确认投递躺在工作台，属"就差用户本人点提交"的活数据，可在与用户沟通时提醒。
