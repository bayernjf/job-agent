# 设计：B 端角色与组织（招聘方声明 + 访问闸）

- 日期：2026-09-25
- 状态：**已拍板（2026-09-25，决策 [#17](待拍板决策清单-20260910.md) 选 A + 五个子问题全部采纳助手建议），未实施**。立场：**分期**——第一期"声明式角色 + 访问闸"，组织/团队/席位缓做；排期按 [#18](design-c-side-first-20260925.md) 的改序结果执行：**F11（投递归属）提前与 C-A 并行，F10（招聘方声明 + `/candidates` 加闸）维持"上线后第一迭代"**。
- 关联：[PRD.md](PRD.md) §3.1/§6、[design-c-side-first-20260925.md](design-c-side-first-20260925.md)（C 端优先，决定本文两半的实施顺序）、[design-auth-gating-20260919.md](design-auth-gating-20260919.md)（两档可见性矩阵）、[proposal-interview-planner-20260922.md](proposal-interview-planner-20260922.md) §4（item45 当时的角色取舍）、[design-demo-mode-20260915.md](design-demo-mode-20260915.md)（三态 Principal）、[deferred-items.md](deferred-items.md)
- 登记：本文是 handoff item59 的设计全文。

## 1. 现状：两侧到底是怎么分的

一句话：**代码里没有 B/C 两套账号，两侧只是同一身份上的视图——而且是四套判据互不一致的视图机制（§1.1），不是一套。**

三层各自的真实状态（HEAD 实查 2026-09-25）：

| 层 | 现状 | 出处 |
| --- | --- | --- |
| 产品 | C = "MVP 主要使用者"，B = "轻量触达，后续主力付费方"；决策 #1-A 定 "C 授权为主脊 + B 公开轻预览" | [PRD §3.1 / §12](PRD.md) |
| 身份 | `Principal` 只有 `anonymous \| demo \| user` 三态，**没有角色概念**；报告页 `resolveViewer` 只有两档 | `apps/api/src/principal.ts`、`apps/report/src/lib/auth.ts` |
| 数据 | `accounts`（010）无角色列；`applications`（009）注释自陈 "No accounts yet"、只按 `profile_id` 归属；`interviews`（012）有 `created_by_account_id` 但归属者只是"某个登录用户" | `db/migrations/{sqlite,postgres}/009~012` |

item45 落地面试计划表时**明确选择**了"个人效率工具最小做法：不引入 recruiter 角色 / 组织实体"（见该提案 §4 与 §7 拍板记录、`packages/shared/src/index.ts` 注释），所以"没有角色"是当时的有意取舍，不是遗漏。本设计是在它之上补第二刀，不推翻它。

### 1.1 两侧到底分在哪：**四个判据互不一致的机制**

"这个项目怎么分 B/C" 的可验证答案。**不是一套角色系统，而是四条各自为政的机制**，判据互相独立，所以"分边"这个动作在产品里其实有四种不同口径：

| # | 机制 | 分什么 | 判据（实测） | 出处 |
| --- | --- | --- | --- | --- |
| ① | 报告页**视角切换** `?view=recruiter` | 同一份画像换排版：招聘方视角隐藏"给候选人看的改进建议"、突出可核验证据 | **URL query**——任何人手敲就能切，无身份判断 | `[profileId].astro:54-58`（`isRecruiter = searchParams.get('view') === 'recruiter'`）；`CandidateWorkspace` 卡片默认带该参数跳详情（`:352/401/483`） |
| ② | 报告页**内容分级闸** | 折叠"原始证据外链 / 面试题 / `interview-kit.md`" | **是否已登录 `user`**——与是不是招聘方无关 | `apps/report/src/lib/auth.ts` 的 `resolveViewer` + `canViewGatedContent`、`GateCard.astro`；handoff item32 |
| ③ | **独立工作台页** `/[locale]/recruit` | 给 B 一个自己的页面（人才检索 + 面试计划） | **无**（SSR 直出候选人首屏，仅 `noindex`） | `apps/report/src/pages/[locale]/recruit.astro` → `CandidateWorkspace` / `InterviewPlanner` |
| ④ | **服务端端点闸** | API 面可见性 | 只有 `/interviews` 三端点要登录；`/candidates`、`/applications` 三条**不查身份** | 无闸：`apps/api/src/index.ts:1384/1429/1439/1469`；有闸：`:1484/1534/1554` |

数据层还有一条平行分界：`profiles` 无主、`applications` 按 `profile_id` 归属、`interviews` 按 `created_by_account_id` 行级归属（009/012 注释自证）。

**一个极易误读的点，值得写死**：`interview-kit.md` 的未登录 401 常被讲成"招聘方端点"，但它只是**登录墙**——任何登录用户（包括完全没在招人的应聘者本人）都能取到。全仓唯一的"角色墙"今天还不存在。

于是"目前主力是哪边"也有可验证答案：**C 端**。判据不是功能条数，而是**B 侧没有任何一条独立身份线**——四个机制里三个（①③④）对"谁在访问"完全不设防，一个（②）用登录态冒充身份；C 侧则是主脊（`accounts` 的语义就是"通过 OAuth 登录的开发者"、claim、报告页、简历、扩展、投递）。**这正是 #17 要收敛的对象**：把 ①③④ 统一到同一条"是否声明"的身份线上，并让 ② 保持不动（它本就不是角色机制）。

### 1.2 三个今天就能打穿的故障面

不是"以后可能有问题"，是现在就可复现的行为：

1. **匿名可检索整个画像库**：`GET /candidates` 无任何身份要求（`apps/api/src/index.ts:1384`），可按技能标签 / 真实性分级 / 置信度 / 平台过滤并分页遍历。单张画像本就公开（决策 #1-A），但"公开单张"不等于"公开可批量遍历的检索接口"——后者是另一件事。
2. **投递记录任何人都能写**：`POST /profiles/:id/applications`（`:1439`）与 `PATCH /applications/:id`（`:1469`）都无归属、无登录。任何人可向任意画像注入投递记录、并改任意一条记录的状态（含改成 `offer`）。
3. **招聘方动作没有身份语义**：`interviews` 三个端点要登录（`:1484` 起），但"登录"不等于"我是替公司看人的"。付费主体识别、企业内协作、以及"画像被招聘方查看是否该告知本人"这三件事目前**无处挂靠**。

## 2. 立场：声明式角色，不做 RBAC，组织缓做

### 2.1 核心机制

**招聘方是一个显式声明，不是一个权限等级。** 账号上记一个"我声明此账号用于招聘"的时间戳；声明即解锁 `/recruit` 工作台、人才检索与面试计划，同时给本人一个反制通道（§6.2）。

### 2.2 为什么不做角色枚举

`accounts` 上加 `role TEXT`（`candidate|recruiter|both`）看着更正规，但语义有洞：**应聘侧不需要声明**。C 侧功能今天对任何登录用户开放，引入 `candidate` 枚举就必然要回答"没声明的人算什么"，于是凭空多出一个 `unspecified` 态和一套迁移历史。本设计只回答"有没有声明"这一个问题。

### 2.3 明确不做（触发条件见 [deferred-items.md](deferred-items.md)）

| 不做 | 理由 | 重启条件 |
| --- | --- | --- |
| 权限表 / RBAC 矩阵 | 两态布尔即可表达，且能被"离职撤权后还能读什么"这种问题直接证伪 | 出现第三种独立权限面 |
| 组织（公司实体） | 无数据源可验证归属；接进来会把猜测当事实入库 | 招聘方出现真实协作或发票需求 |
| 席位 / 计费 | 依赖 #9 商业模式与真实成本计量 | #9 拍板且成本回采到位 |
| 多人共享面试数据 | 会把 012 的 `created_by_account_id` 行级归属语义改深 | 组织就位后 |

### 2.4 为什么不干脆只做访问闸、连角色都不提

那确实是更小的改动，且第 1 节的问题 ①② 全都能修掉。但它把问题 ③ 原样留着，并且丢掉了本设计真正的产品价值：**两侧共用一个账号是暂时状态，不是终局**（PRD §3.1 把 B 写成"后续主力付费方"；[deferred-items 合规线](deferred-items.md) 记录的对位竞品 DINQ 正是 B 端画像产品）。现在加一列的成本接近零，事后从"任何人都能看人才库"改口成"要声明"的成本会随用户数上升。

## 3. 数据模型：迁移 013，零新表

双方言、编号与文件名对齐（`bash tools/check-migrations.sh` 校验）。类型沿用双方言约定：时间戳两版都是 `TEXT`（见 010 PG 迁移注记：不引入 `TIMESTAMPTZ`）。

```sql
-- 013_add_application_ownership.sql · 两侧各一份（**随 C 端 C-A 同期落地**，#18 已拍板把 F11 提前）
ALTER TABLE applications ADD COLUMN created_by_account_id TEXT;  -- 存量行为 NULL，语义见 §5
-- 014_add_recruiter_declaration.sql · 两侧各一份（F10，维持"上线后第一迭代"原序）
ALTER TABLE accounts     ADD COLUMN recruiter_declared_at TEXT;  -- NULL=未声明；UTC ISO8601=声明时刻
```

> **编号拆开是刻意的**（2026-09-25 #18 拍板结果）：投递归属（F11）保护的是求职者自己的数据，与 B 端声明（F10）不必同期。F11 先以"仅登录、不分角色"的形态落地，补 F10 时只把闸的判据从 `user` 换成 `user && declared`，**不回头改归属列**。原稿把两列塞进同一份 013，那会把 B 端排期变成隐私修复的阻塞项。

- 不加索引：`GET /interviews` 按 `created_by_account_id` 过滤走的是 012 已建的 `idx_interviews_owner_status`（`(created_by_account_id, status, scheduled_start)`），本设计不动它；`applications` 侧本设计只按主键 `id` 做 PATCH 归属校验，不新增列表查询，故不加索引。
- **不给 `recruiter_declared_at` 加 CHECK 约束**：`TEXT` 可空、值域由应用层 Zod 与仓储方法保证；ALTER 加 CHECK 在 SQLite 上需重建表，代价远大于收益。
- 回滚（DOWN）：SQLite 侧 DROP COLUMN，PG 侧 `DROP COLUMN IF EXISTS`。

## 4. 身份解析

- **shared**：`Principal` 的 `user` 分支**不加字段**。角色是账号属性而非会话属性，塞进 Principal 会让每次解析都要多查一列并产生"缓存不一致"。`StoredAccount` 加 `recruiterDeclaredAt: string | null`，由现有 `accounts.getById()` 直接带出。
- **API**：新增中间件级 helper `requireRecruiter(principal, accounts)`，返回 `user + account` 或抛出统一结果。判定与 `GET /auth/me` **走同一次 `accounts.getById`**，不在路由内二次查库。
- **报告页**：`Viewer['user']` 加 `recruiter: boolean`，同一次查询内得出。
- **新增错误码**：`AUTH_ERROR_CODES.recruiterRequired = 'RECRUITER_DECLARATION_REQUIRED'`。
- 不变式：`upsertFromProvider` **永不改动 `recruiter_declared_at`**（重新登录不得静默撤权）；`deleteUnclaimed` **永不清理 `recruiter_declared_at IS NOT NULL` 的账号**（§7.1，同一份守护）。

## 5. 权限矩阵（改造后）

图例：**A** = `anonymous`　**D** = `demo`　**U** = 已登录未声明　**R** = 已登录且已声明。加粗 = 相对现状收紧。

| 表面 | A | D | U | R |
| --- | --- | --- | --- | --- |
| `GET /profiles/:id`、`/exportable`、`/by-subject/*` | 200 | 200 | 200 | 200（不变） |
| 报告页结论 / 技能 / 匹配 / 简历 / 投递与匹配理由证据 | 可见 | 可见 | 可见 | 可见（决策 #10 可回溯要求，不收紧） |
| 报告页原始证据外链 / 面试题 / `interview-kit.md` | 墙 | 墙 | 全见 | 全见（item32 现状，不动） |
| `GET /candidates` | 401 | 401 | **403** | 200（现状：四态全开） |
| `/[locale]/recruit` 页面 | SSR 渲染声明墙 | 同左 | 同左 | 200（页面 `noindex`；机器可读入口是上面的端点，墙挡不住爬虫这个假设不成立——它靠的是 `noindex` + 端点闸） |
| `POST /interviews`、`GET /interviews`、`PATCH /interviews/:id` | 401 | 401 | **403** | 200（现状 U 可写，收紧为 R） |
| `POST /profiles/:id/applications` | 200（`created_by_account_id` 记 NULL） | 200（同左） | 200（记本人 id） | 200（记本人 id） |
| `PATCH /applications/:id` | 行归属为 NULL → 200；否则 **404** | 同左 | 同主键归属 | 同主键归属 |
| `PUT` / `DELETE /auth/recruiter` | 401 | 401 | 200/204 | 200/204（幂等） |

**硬约束（改这块时不许动）**：① `analyzer-core` 不感知身份与角色；② `/analyze` 的"画像缓存命中先于权限检查、命中不扣配额"顺序不变；③ 既有 `DEMO_REQUIRED` / `QUOTA_EXCEEDED` / `RATE_LIMITED` 语义与触发点不变，新码只加不改。

### 5.1 PATCH 的 NULL 归属可改是安全洞还是兼容包袱

现状是"任何人都能改任何人那条记录"，改后是"无主记录仍可改、有主记录只有主能改"。**非归属方返回 404 而非 403**，与 `PATCH /interviews/:id` 既有约定一致（代码注释原话："非本人资源一律 404（不泄露存在），不物理删除"）——同一仓库里两类行级归属资源应给爬虫相同的探测反馈。**不回改历史行**：投递记录无删除面（`withdrawn` 是状态而非删除），猜 `app-<uuid>` 理论可撞但实际不可枚举。若要更严，选项是"NULL 行只允许登录用户改"——代价是老用户在登录设备上的记录变成只读。**这条列为 §8 待拍板问题 3**，不在此替你定。

## 6. 端点、storage 与 UI

### 6.1 新端点

```text
PUT    /auth/recruiter   声明（幂等）→ 200 { recruiter:true, recruiterDeclaredAt }
                          首次写入当前时间，再次 PUT 不回写、不刷新时间戳
DELETE /auth/recruiter   撤销 → 204（无版本、无 if-match：声明是可逆幂等开关）
```

`GET /auth/me` 响应加两个字段（只加不删，向后兼容）：`recruiter: boolean`、`recruiterDeclaredAt: string | null`。

### 6.2 声明时要展示什么（本设计的合规价值集中在这两行）

声明确认框必须写清后果，否则它只是一个复选框：

- **对本人**："声明后你可在此查看候选人画像与面试数据；你的账号不会因此对候选人公开。"
- **对候选人**："被招聘方账号查看画像不会通知本人"这一现状在此明示，并预告 §6.3 的反制通道。
- **反制通道**：撤销入口与异议入口（`PUBLIC_DISPUTE_EMAIL`）在确认框内就近给出，不让人去隐私政策里翻。

### 6.3 storage 仓储

- `IAccountsRepository`：`declareRecruiter(accountId, nowIso)`、`revokeRecruiter(accountId)`（幂等；账号不存在返回 `undefined`）；`getById` 返回体加 `recruiterDeclaredAt`。
- `IApplicationsRepository`：`insert` 入参加可空 `createdByAccountId`；`update` 加可选 `requireOwnerId`（NULL 放行规则见 §5.1）。
- **裸 SQL 只出现在双实现内部**，业务模块只调接口（AGENTS 硬约束）。

### 6.4 报告页

- `GateCard` 现在只有 `loginHref` 一个链接出口，表达不了"要 POST 才能过的墙"。改法：加可选 `declareHref` 与一个 `cta` 插槽，**保持纯 SSR、无 JS 依赖**（与 item32 同一哲学）。
- 未声明访问 `/recruit` → 渲染声明墙；点"我是招聘方"→ 走带 `return_to` 的 `GET /auth/recruiter/consent`（已登录可直接 `PUT`，未登录先走 OAuth 回跳同一深链）。
- `AccountMenu` 加"招聘方"徽章与声明/撤销菜单项。
- 新增约 18 对中英 key（`recruit.gate.*`、`account.recruiter.*`），一致性守护已覆盖；样式全走 `--ja-*` token。
- **扩展不涉及**：content script 只读 ATS 页，OAuth / HttpOnly cookie 不适用（与 item29 同一结论）。

## 7. 与既有机制的相互作用（三条非显然后果）

这三条是本设计的主要风险，落地时必须逐条有测试。

### 7.1 `auth cleanup` 会把招聘方账号物理删掉（必须先修）

`IAccountsRepository.deleteUnclaimed` 的定义是"删除从未认领画像、`updated_at` 早于保留期、且无未过期会话的账号"。而**招聘方通常根本不认领自己的画像**——三个删除条件对他们是常态。后果：`accounts` 行连同新加的声明列一起物理消失，`interviews.created_by_account_id` 成悬空引用、`GET /interviews` 再也查不到，更糟的是**重新登录后声明静默回来**（upsert 建新行、新列为 NULL）。这是"权限被后台悄悄收回又悄悄放开"的完整循环。

处置（写进本设计、不是留给实现者）：谓词加 `AND recruiter_declared_at IS NULL`，即**声明过招聘方的账号永不被 `deleteUnclaimed` 清理**；认领条件保持不变，普通求职者账号的清理语义与 item29 承诺逐字一致；`apps/cli` auth cleanup 测试补一条"已声明招聘方 + 无认领 + 无活动会话 → 0 删除"。
（本设计**不**改动该 cron 的"默认 30 天 / 用户可指定"参数语义——那属于 item55 那条线；此处只加一条硬过滤条件。）

### 7.2 收紧 `/candidates` 不会让招聘方工作台坏掉，但会让它"空"

`/recruit` 是 SSR 直读 storage 渲染首屏、之后同源 `GET /candidates` 做过滤分页。加了闸之后未声明用户看到的是**墙**（不是半屏数据 + 报错），所以墙必须同时替换掉 SSR 首屏那 12 条 SSR 直出的候选人，不能只挡 XHR。另外：招聘方检索的是"已经被分析过的画像"，上线初期库里只有 3 个预置 demo 画像 + 你自己认领的那张，`/recruit` 会近乎空。**这是预期，不是 bug**，但不写清会让下一位以为闸接错了。

### 7.3 声明必须是显式 POST，不能由"访问了 /recruit"推导

若按"访问过人才库即视为招聘方"来自动打标，会立刻撞上 §6.2 的合规前提：候选人侧的可见性依赖"招聘方是显式声明的一群人"，自动打标等于把所有人都算进去。显式声明同时是审计事件的唯一来源。

## 8. 待拍板问题（决策 #17）

| # | 问题 | 助手建议 |
| --- | --- | --- |
| 1 | `/interviews` 要不要一并收紧为"声明者才可写"？现状是任何登录用户可写面试记录 | 收紧，与 `/candidates` 同批。半收半放会让"我登录了为什么能排面试、却不能看列表"变成无法解释的裂缝 |
| 2 | 声明是否需审核 / 门槛（企业邮箱、实名） | **不需**。MVP 期声明唯一作用是给自己解锁视图，多一步审核就多一个漏斗出口，且当前无滥用信号 |
| 3 | `applications` 是否补 `created_by_account_id` | **补，可空**（§3、§5.1）。顺手修掉"任何人都能改投递状态"，并为将来"我的投递"跨画像聚合留列 |
| 4 | `GET /candidates` 是否只对 `user` 开放、还是进一步只对声明者开放 | **只对声明者**。这样才真正回答"谁在批量检索未经本人授权的画像"——`/candidates` 是该问题唯一仍全开的入口（单张画像公开是决策 #1-A 的既定取舍，不在本设计范围内） |
| 5 | 落地排期与是否拆阻塞上线的刀 | **整体上线后第一迭代**，不阻塞当前 MVP（当前唯一硬阻塞仍是 P0-3 形态 C 控制台部署）。若产品判断"匿名可遍历画像库"不该带着上线，则把 `GET /candidates` 加闸单拆一次先行——其余留后 |

## 9. 落地顺序与验证

拆原子提交（AGENTS：功能/迁移/文档/测试不混提）：

1. `feat(shared)`：`StoredAccount.recruiterDeclaredAt`、`RECRUITER_DECLARATION_REQUIRED`、`/auth/me` 响应契约、`PUT /auth/recruiter` 请求 Zod
2. `feat(db)`：迁移 013 两侧 + `bash tools/check-migrations.sh`
3. `feat(storage)`：`declareRecruiter` / `revokeRecruiter` + `applications.created_by_account_id` 双实现 + §7.1 的 `deleteUnclaimed` 谓词调整
4. `feat(api)`：`PUT`/`DELETE /auth/recruiter`、`requireRecruiter` 闸、`/auth/me` 加字段、PATCH 归属校验、`docs/API.md` 同步
5. `feat(report)`：`GateCard` 插槽、`/recruit` 声明墙、`AccountMenu` 徽章与开关、中英 key
6. `test`：api 就近单测（含植入探针）、`pnpm e2e` 补"匿名→墙 / 声明→列表"、`pnpm e2e:extension` 回归（预期零改动）
7. `docs`：隐私政策权威源 + 在线页同步、PRD 状态与 F10、handoff item59 关单 + 滚归档

交付门禁：`pnpm -r typecheck`、`pnpm -r test`、`pnpm -r build`、`bash tools/check-migrations.sh`、`git diff --check`；UI 改动必须真跑 `pnpm e2e`。本地最快复跑：`pnpm --filter @jobagent/api exec vitest run src/doc-links.test.ts src/doc-commands.test.ts`。

文档联动：
- [design-auth-gating-20260919.md](design-auth-gating-20260919.md) §4 现写着"**不做招聘方白名单**/名单审核"。本设计引入的是**自声明门（无任何审核）**，与该句的"名单审核"部分不冲突，但"不做白名单"部分被本设计改口——落地时须回去在那一行加一句"2026-09-25 起改口，见 [design-recruiter-roles-20260925](design-recruiter-roles-20260925.md)"，否则两份文档互相矛盾。
- `docs/API.md`：新端点 + 新错误码 + `GET /auth/me` 新字段。**另外三节的「访问前提」必须同步改**，它们已在文档里（§3.5 `GET /candidates`、§3.6 `/applications` 三条、§3.7 `/interviews` 三条），改闸不改文档 = 对外承诺一套、实跑另一套；`api-doc-consistency` 守护只做"路由 ↔ 文档"双向对齐，**不校验访问前提的措辞**，所以这三处只能人工核对，落地时列为 checklist 项而非依赖守护。
- 隐私政策：§6.2 的声明后果文案要进权威源 md、在线页与 `apps/report/src/pages/privacy-content.test.ts` 三处（该测试现钉"中英各 10 节"，新增小节必须同步改节数断言）。
- 本设计落地后：PRD F10 状态改「已落地 + handoff item 号」。新文档需同时在 [../handoff.md](../handoff.md)「Project documents」登记一行、并在 [README.md](README.md) 补场景入口（AGENTS 的文档分层硬约束）。

## 10. 一句话结论

本设计的全部范围是：**`accounts` 加一列声明时间、`applications` 加一列可空归属、`GET /candidates` 与 `/interviews` 写侧从"登录即可"收紧为"声明即可"、新增 `PUT`/`DELETE /auth/recruiter` 两个端点**，零新表。它不解决团队协作与商业化，但把"招聘方"这个身份第一次变成数据模型里可查询、可撤销、可被引用的东西。
