# 设计：S3 按主体撤回（未认领画像分享链自助撤销）

> 状态：**已落地**，2026-10-01（handoff item93，审计 S3 修复）。本文件是「未认领画像的分享链接如何由数据主体自助申请撤回」的设计与实现记录。
>
> 关联：审计发现 [代码审计与功能全景-20260930.md](代码审计与功能全景-20260930.md) §3.2 **S3【已确认】未认领画像的分享链实际不可撤销**；决策 #14 已决策「应求撤销」通道（报告页邮件异议）；本设计为 S3 的落地实现。

---

## 1. 问题

分享链接是 capability URL（`profileId = randomUUID`，`apps/worker/src/index.ts`），无 token、无过期、无独立撤销端点。唯一撤销路径 `DELETE /profiles/:id` 只对**已认领本人**开放（`apps/api/src/index.ts` 的 `AUTH_PROFILE_OWNER` 校验），对**未认领**画像返回 403。

未认领画像的主体（即该 GitHub/Gitee 用户名本人）想要撤回却做不到，因为：

1. 服务端**无法证明**提请求的人就是画像主体——未认领意味着没有 OAuth 认领记录，匿名端点又不能做身份断言；
2. 若直接给匿名端点开放「销毁不可变快照」的能力，等于任何人都能凭一个 username 删掉别人的公开画像， abuse 面极大。

决策 #14 已提供「邮件异议 → 人工处理」的应求撤销通道，但缺少**自助入口**。S3 即是补这个入口。

## 2. 方案选择

考虑过三种路径：

| 方案 | 描述 | 否决理由 |
| --- | --- | --- |
| A. 匿名端点直接删除 | 公开 `DELETE /profiles/:id` 去 owner 校验 | 任何人可删他人画像，滥用面不可接受 |
| B. 未认领也放开 OAuth 认领即可删 | 引导主体先登录认领再走既有 `DELETE` | 仍要求主体完成 OAuth 登录；而**匿名**主体（不愿/不会登录）想要一键撤回时无入口，且 S3 暴露的正是「未登录也能提申请」的需求 |
| **C. 公开申请 + 人工复核（选定）** | 开放公开 `POST /profiles/:id/removal-request`（匿名即可提），提交即软挂起，运营在 CLI `removal` 命令组复核后批准（级联删除）或驳回 | 既给主体自助入口，又把「销毁不可变快照」这一不可逆动作锁在人工复核之后，避免匿名滥用 |

选 C 的核心权衡：**自助提申请 ≠ 自助立即删除**。申请只留痕（理由/联系方式/IP 加盐哈希），真正删除由运营在核验请求合理性后执行。这与决策 #14「应求撤销」口径一致，只是把入口从「发邮件」前移到「报告页一键申请」。

## 3. 机制总览

```
主体（匿名）                API                         Storage                      运营 CLI
  │                           │                             │                            │
  │ POST /profiles/:id/       │                             │                            │
  │   removal-request         │                             │                            │
  ├──────────────────────────►│ 1. 校验画像存在(404)         │                            │
  │                           │ 2. IP 滑窗 'removal'(429)   │                            │
  │                           │ 3. 幂等：已有 pending→200   │                            │
  │                           │ 4. 写 profile_removal_     │                            │
  │                           │      requests(pending)      │                            │
  │                           │ 5. profiles.setRemoval     │                            │
  │                           │      RequestedAt(ts)  ← 软挂起                            │
  │                           │ 6. 写 demo_rate_events      │                            │
  │◄──────── 202 {pending} ────┤                             │                            │
  │                           │                             │                            │
  │        (此后 by-subject 不再返回该画像；analyze 返回 409 REMOVAL_PENDING)              │
  │                           │                             │                            │
  │                           │                             │  removal list --status pending
  │                           │                             │◄───────────────────────────┤
  │                           │                             │  removal approve --request X
  │                           │                             │   级联删除 evidence→applications→
  │                           │                             │   interviews→accounts 认领解绑→
  │                           │                             │   profiles.deleteById；decide('approved')
  │                           │                             │  removal reject --request X
  │                           │                             │   setRemovalRequestedAt(null)；decide('rejected')
```

### 3.1 软挂起（soft hold）

画像被申请后立刻置 `profiles.removal_requested_at = <UTC ISO8601>`，非空即「挂起」。挂起态的可见性影响：

- `GET /profiles/by-subject/:platform/:login`（`apps/api/src/index.ts`）：命中条件收紧为 `status∈{complete,partial} && !removalRequestedAt`，挂起画像对该端点**不再返回**（避免撤回申请后被继续检索分发）。
- 人才库 `/candidates` 直出与报告页默认检索同理应排除挂起行（检索侧按 `removal_requested_at IS NULL` 过滤）。
- `POST /analyze`（`apps/api/src/index.ts`）：若 `latestBySubject` 命中且 `removalRequestedAt` 非空，返回 **409 `{code:'REMOVAL_PENDING'}`**，不让同一主体被重复分析、也不让挂起画像被刷新覆盖。

> 软挂起而非硬删，保证「申请中」与「复核驳回恢复」之间，既有分享链接不会因误申请而瞬断；驳回即清空 `removal_requested_at`，画像恢复如初。

### 3.2 人工复核（CLI `removal` 命令组）

`apps/cli/src/removal-commands.ts` 的 `runRemoval` 派发三个子命令，依赖 `createStorage()` 与 `ApiRepos` 同套仓储：

- `removal list`（默认 `--status pending --limit 50`）：列出待复核申请，便于运营批量处理。
- `removal approve --request <id>`：**级联删除**——先删 `evidence` → `applications` → `interviews` → 调 `accounts.clearClaimedProfileByProfileId(profileId)`（解绑任何认领该画像的账号）→ `profiles.deleteById(profileId)`，最后 `profileRemovalRequests.decide('approved')`。
- `removal reject --request <id>`：`profiles.setRemovalRequestedAt(profileId, null)` 解除挂起，再 `decide('rejected')`。

退出码：请求不存在→1；已决定（重复操作）→2；缺少 `--request`→2。

## 4. 数据模型（零新增实体，复用迁移 016/017）

- **迁移 016** `profile_removal_requests` 表（双方言 `db/migrations/{sqlite,postgres}/016_create_profile_removal_requests.sql`）：
  `id`（`rem-<uuid>`）、`profile_id`、`status`（`pending|approved|rejected`）、`reason`、`contact`、`ip_hash`（与 `demo_rate_events` 同款加盐哈希 helper）、`created_at`、`decided_at`。`profile_id` 刻意**不建外键**——级联删除在应用层按固定顺序执行（见 §3.2），迁移 `down` 仅 `DROP TABLE`。
- **迁移 017** 给 `profiles` 加 `removal_requested_at TEXT`（双方言 `017_add_profile_removal_requested_at.sql`），即软挂起标志。
- 仓储：`packages/storage/src/repositories/profile-removal-requests.ts`（`IProfileRemovalRequestsRepository`：`insert`/`findPendingByProfile`/`listByStatus`/`decide`），实体 `packages/storage/src/entities/profile-removal-request.ts`（`RemovalRequestStatus = 'pending'|'approved'|'rejected'`、`StoredProfileRemovalRequest`、`NewProfileRemovalRequest`）。`profiles` 仓储已有 `setRemovalRequestedAt` 与 `insert` 持久化 `removalRequestedAt`。
- `StorageContext` 在 `packages/storage/src/storage.ts` 的两个工厂里装配 `profileRemovalRequests`。

> 注：这两条迁移是**新增**（016/017），不是复用 #17 的 015——#17 的 015 是招聘方声明表。本设计独立占 016/017，互不影响。

## 5. 限流（防刷，非鉴权）

端点任何身份放行，唯一约束是 IP 滑窗，复用 demo 限流的 `DemoRateKind` 机制：

- `packages/shared/src/index.ts` 的 `DEMO_RATE_KINDS` 由 `[session,analyze,match,subject]` **新增 `removal`** 桶（`DemoRateKindSchema` 同步）。
- `apps/api/src/demo-config.ts` 新增 `removalRatePerHour`（默认 `5`），`DEMO_REMOVAL_RATE_PER_HOUR`（`.env.example` 同步，默认 `5`）。
- 端点内：`demoSessions.countRateEvents(ipHash, 'removal', since)` 超限回 **429 `{code:'DEMO_RATE_LIMITED', bucket:'removal', retryAfterSeconds:3600}`**，并 `console.info('[removal] result=blocked ...')`；通过后 `insertRateEvent(ipHash, 'removal', now)`。
- env 四处同步：`.env.example` / `docs/API.md`（环境变量表 + 端点 429 说明）/ `demo-config.test.ts` 配置夹具 / 守护扫描。

## 6. 报告页入口（应聘方自助）

- `apps/report/src/components/RemovalRequest.tsx`（React island，`client:load`）：仅在 `claimed === false && !removalRequestedAt` 时挂载。渲染 `<details>` 含理由 `textarea`、联系方式 `input`、提交按钮；`fetch('/profiles/:id/removal-request', {credentials:'include', method:'POST', body})`；200/202 后 `window.location.reload()` 让 SSR 挂起横幅接管；其余状态显示错误文案。
- `[locale]/report/[profileId].astro`：提交后由 SSR 渲染 `.ja-alert--removal` 横幅（`data-testid="removal-notice"`）；`RemovalRequest` 只在 `!claimed && !isHeldForRemoval` 分支挂载。
- i18n：在 `apps/report/src/i18n/messages/{zh-CN,en}.json` 新增 8 个 `report.removal.*` key（`notice`/`cta`/`submitting`/`submitted`/`error`/`reasonPlaceholder`/`contactPlaceholder`/`hint`），en 无 CJK、占位符与 zh 对齐（受 `i18n.test.ts` 守护）。
- 样式：`apps/report/src/styles/global.css` 新增 `.ja-alert--removal`（复用 `--ja-color-neutral-100`/`--ja-color-info` token，无裸 hex）与 `.removal-request*` 一组。

## 7. API 契约（见 docs/API.md）

`POST /profiles/:id/removal-request`：

| 码 | 情形 |
| --- | --- |
| 200 | 已有 pending 申请，直接返回（`idempotent: true`） |
| 202 | 申请已受理（画像进入挂起态，等待人工复核） |
| 400 | `id` 格式非法 / 请求体字段超长 |
| 404 `PROFILE_NOT_FOUND` | 画像不存在 |
| 429 `DEMO_RATE_LIMITED` | 同 IP 一小时内提交超过 `DEMO_REMOVAL_RATE_PER_HOUR`（`bucket:'removal'`） |

`POST /analyze` 新增 **409 `REMOVAL_PENDING`**（挂起画像不可重分析）。`by-subject` 对挂起画像不再命中（见 §3.1）。

## 8. 测试覆盖

- `packages/storage/src/profile-removal-requests.test.ts`（6 例）：insert / 按 profile 查 pending / 幂等 decide。
- `packages/storage/src/schema-parity.test.ts`：`TABLES` 增加 `profileRemovalRequests` 保证双方言表存在。
- `apps/api/src/index.test.ts`（S3 块，6 例）：404 / 202 软挂起 / 幂等 200 / 429 / by-subject 命中挂起返回 404 / analyze 409 REMOVAL_PENDING。
- `apps/cli/src/removal-commands.test.ts`（8 例）：list / approve 级联删除 / reject 解除挂起 / 派发错误（请求不存在=1、已决定=2、缺 `--request`=2）。
- `packages/shared/src/demo-mode.test.ts`：`DemoRateKindSchema` 断言含 `removal`。
- `apps/api/src/demo-config.test.ts` / `demo.test.ts` / `demo-quota-concurrency.test.ts`：配置夹具加 `removalRatePerHour:5`。

## 9. 与隐私政策的关系

`docs/privacy-policy-20260924.md` §5（数据留存与删除）与 §7（你的权利）已补充「未认领画像可在报告页**无需登录**自助提交撤回申请，画像挂起等待复核」的说明，并强调申请仅记录理由、可选联系方式与 IP 加盐哈希。在线页 `apps/report/src/pages/[locale]/privacy.astro` 的内联章节标题与权威源保持 11 节一致（`privacy-content.test.ts` 守护，本次未改标题与节数）。

## 10. 验证（2026-10-01 实跑）

- `pnpm -r typecheck` 全绿；`pnpm --filter @jobagent/{shared,storage} build` 后依赖方 tsc/tests 拾取新 `dist`。
- `pnpm -r test` 全绿：storage 158 / api 212 / cli 17 / report 69（i18n 22 + credentials-guard 15 在内）/ mcp 24。
- `bash tools/check-migrations.sh` 17 对 0 warning（016/017 新增，命名与文件头符合规范）。
- `git diff --check` 干净。

## 11. 已知限制 / 后续

- **人工复核是必要的人肉环节**：申请不会自动删除，需运营跑 `removal list`/`approve`。若未来要做「认领即自助删」（方案 B）需先解决匿名身份断言问题，不在本设计范围。
- 申请记录（含 `reason`/`contact`）属于可联系主体的 PII，复核完成后若需长期留存应满足最小保留期，目前随 `decide` 落 `decided_at` 但行不删；如需 purge 留作 deferred。
- 报告页只在**未认领且未挂起**画像展示入口；已认领画像仍走既有 `DELETE /profiles/:id`（本人）。
