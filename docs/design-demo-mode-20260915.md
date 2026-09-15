# 演示模式（Demo Mode）设计：免注册临时身份、真实产品体验与配额闸

> 状态：现行（2026-09-15，设计已落文档；**实现尚未启动，需先拍板 §16 的开放项**）
> 关联：[deferred-items.md](deferred-items.md) 平台与工程线「账号体系 / 本人认领头表」、[design-storage-dual-dialect-20260911.md](design-storage-dual-dialect-20260911.md)、[API.md](API.md)、[design-i18n-20260910.md](design-i18n-20260910.md)、[design-tokens-20260910.md](design-tokens-20260910.md)

## 0. 背景、目标与非目标

### 0.1 要解决的问题

新用户在落地页/报告页看到产品，但当前只有两条路：

1. 直接输用户名触发分析——**没有任何身份与限制**，任何人都能用我们的 GitHub/Gitee 服务端配额无限触发采集；
2. 注册登录——**账号体系（OAuth/accounts/claim）仍在 deferred 缓做**，为了"先试试看"就做完整账号体系过重。

需要第三种状态：用户点「试用演示」即可进入**真实产品**（真实跑分析、看真实报告页与岗位匹配），不需要注册；但服务端知道"这是一个演示会话"，对**消耗外部平台配额的动作**（触发采集分析）施加严格、可防滥用的限额，并在限额用尽时引导留资（waitlist）转化。

### 0.2 核心判断

**演示模式要限制的是"触发新分析"这个消耗 GitHub/Gitee API 配额的动作，不是"查看已生成的公开报告快照"。** 画像报告本来就是公开只读分享链路（`GET /profiles/:id`、`/exportable`、报告页 SSR），对查看行为设限只会把产品体验做死，且没有外部成本。因此：

- 看已存在的画像/岗位数据 → 始终放行（含完全匿名）；
- 触发一次新的采集分析 → 必须持有有效演示会话，且受会话/IP/Worker 三道配额闸约束；
- 未来的正式登录用户 → 预留身份枚举，本次不实现 OAuth。

### 0.3 目标

1. 新用户零表单进入：一次点击获得服务端临时会话（HttpOnly Cookie），随后操作的是**真实 API、真实 Worker、真实报告页**，不 mock 产品链路。
2. 配额可防滥用：单会话次数硬上限（原子扣减，并发不超用）、单 IP 滑动窗口（防清 Cookie 重置）、Worker 侧 demo 并发闸（正式流量优先、保护 token 消耗速率）。
3. 秒进体验：离线 seed 少量预置画像快照，点预设示例账号**命中画像缓存、不耗实时配额、毫秒级跳报告页**；同时允许用户输入任意真实平台用户名走完整链路（受配额限制）。
4. 与未来账号体系解耦：三态身份模型里 `user` 只预留枚举与分支位置，不提前实现 OAuth/认领（deferred 原条目不重启）。
5. 全程遵守既有工程约束：DB 访问只走 storage 仓储、双方言迁移对称、用户可见文案走 `t()` 中英双语、样式只用 `--ja-*` token、MVP 不引入 Redis。

### 0.4 非目标（本次明确不做）

- 不做注册/登录/密码/OAuth/账号合并/本人认领（继续缓做，触发条件不变）。
- 不做演示数据与未来正式账号的归属迁移（演示会话 TTL 后即失效，不承诺保留；未来账号体系上线时如需"演示记录找回"另立设计）。
- 不做付费/计费、不做邮件验证、不做验证码（IP 窗口 + 低配额已覆盖 MVP 威胁模型；验证码等上线后按滥用日志再议）。
- 不在浏览器扩展里引入演示会话（理由见 §10）。
- 不改 analyzer-core、不改画像契约 `AbilityProfile`、不改 RULE_VERSION（演示是接入层/身份层特性，与分析内核无关）。

---

## 1. 三态身份模型（Principal）

全系统统一为三种请求身份，定义在 `packages/shared`（单一事实源，见 §6）：

| kind | 中文称呼 | 如何识别 | 持久化 |
| --- | --- | --- | --- |
| `anonymous` | 匿名访客 | 无 `jobagent_demo` Cookie，或 Cookie 对应会话不存在/已过期/已退出 | 无 |
| `demo` | 演示用户 | 持有有效 `jobagent_demo` Cookie，服务端 `demo_sessions` 表有对应 active 行且未过期 | 服务端会话行（TTL）+ HttpOnly Cookie |
| `user` | 正式用户（**仅预留，不实现**） | 未来 OAuth 后的登录态 | 未来 accounts 体系 |

类型形态（API 内部使用，不直接暴露内部 id 之外的敏感字段）：

```ts
// packages/shared 新增（详见 §6）
export type RequesterKind = 'anonymous' | 'demo' | 'user';

export type Principal =
  | { kind: 'anonymous' }
  | {
      kind: 'demo';
      sessionId: string;            // = demo_sessions.id = Cookie 值
      analyzeCount: number;         // 本会话已用分析次数
      matchCount: number;
      expiresAt: string;            // ISO8601
    }
  | { kind: 'user'; userId: string }; // 本次不产生这种值，仅保留编译期分支完备性
```

设计要点：

- **身份解析在 API 边缘完成一次**（中间件），下游 handler 只读 `c.get('principal')`，不各自解析 Cookie（避免策略漂移）。
- Cookie 无效/过期时**静默降级为 anonymous**（不报错、不删 Cookie；退出端点负责主动清除），保证坏 Cookie 不卡死用户。
- `user` 分支只出现在类型与 switch 的穷尽检查里；本次没有任何代码路径产生它，注释标明"reserved for accounts milestone"。

---

## 2. 权限矩阵

| 动作 / 端点 | anonymous | demo | 备注 |
| --- | --- | --- | --- |
| `GET /health` | ✅ | ✅ | 不变 |
| 看公开画像 `GET /profiles/:id`、`/exportable`、`/job-recommendations` | ✅ | ✅ | 公开只读分享链路，**永不加限** |
| 岗位检索 `GET /job-postings*` | ✅ | ✅ | 只读本地库，公开数据聚合 |
| `POST /job-postings/match` | ✅ | ✅（计数观测） | 纯本地计算、无外部配额成本；仅 IP 窗口兜底，不设会话硬配额（见 §7.4，是否加硬限为待拍板项） |
| `GET /jobs/:id` 轮询任务状态 | ✅ | ✅ | 任务状态不含隐私，分享/轮询链路依赖其公开 |
| **`POST /analyze` 且命中未过期画像缓存** | ✅ | ✅，**不扣次数** | 缓存检查先于权限检查（§7.3），预置示例秒进靠它 |
| **`POST /analyze` 需新建分析任务** | ❌ 403 `DEMO_REQUIRED` | ✅，过三道配额闸后放行 | 唯一被身份限制的动作 |
| `POST /demo/sessions` 建演示会话 | ✅（受 IP 建会话窗口限制） | 幂等：已有有效会话则直接回当前会话 | — |
| `GET /demo/me` 查当前身份与剩余配额 | ✅（回 anonymous） | ✅ | 前端 Banner 用 |
| `POST /demo/exit` 退出演示 | ✅（no-op） | ✅ | 置 exited + 清 Cookie |
| 未来：账号认领 claim / 定时刷新 / 批量分析 / 数据导出 / 管理端点 | ❌ | ❌ **永久禁止**（demo 永不开放） | 仅未来 `user`/管理员可用 |
| CLI 本地命令 | 不经过 HTTP 身份层 | 不适用 | CLI 是开发者工具，本地持有 token，不受 Web 配额约束 |

矩阵原则：**只读公开数据一律放行；只有"花外部钱"的新分析触发需要 demo 身份；demo 永远拿不到账号级/管理级能力。**

---

## 3. 配额三道闸

仅作用于"demo 触发新分析"。三道闸独立、纵深防御，任何一道不过都拒绝并返回结构化错误（§7.5）。

### 3.1 第一道：会话级原子扣减（硬配额）

- 每个 `demo_sessions` 行有 `analyze_count`，建议上限 **3 次/会话**（数值待拍板，§16-#1）。
- 扣减必须是**单条条件 UPDATE**，看影响行数判定是否拿到名额，**严禁 select-then-update**（两个并发请求会同时读到旧值而双超）：

  ```sql
  -- 语义（双方言实现见 §5.4）：
  UPDATE demo_sessions
     SET analyze_count = analyze_count + 1, last_seen_at = :now
   WHERE id = :id
     AND status = 'active'
     AND expires_at > :now
     AND analyze_count < :quota;
  -- 影响 1 行 → 拿到名额；影响 0 行 → 会话不存在/过期/已退出/配额用尽
  ```

- 画像缓存命中（无新分析）**不扣减**；active job 去重命中（`latestActiveBySubject` 返回已有 queued/running 任务）也**不扣减**（没有产生第二个采集任务）。扣减成功后若后续 `jobs.create` 抛错，需在 catch 中回滚名额（仓储补 `releaseAnalyzeSlot`，仅用于这种"扣了但没建成任务"的补偿路径；正常分析失败重试不回名额，因为外部配额可能已被 Worker 消耗）。

### 3.2 第二道：IP 滑动窗口（防清 Cookie 重置）

清掉 Cookie 就能无限开新会话，因此叠加按 IP 的窗口限流。**只存加盐哈希、不存明文 IP**（§12）。窗口计数落 `demo_rate_events` 表（MVP 不引 Redis）：

| 窗口（建议值，待拍板） | 阈值 | 作用端点 |
| --- | --- | --- |
| 建会话 1 小时滚动窗 | 5 个/IP/h | `POST /demo/sessions` |
| 触发分析 1 小时滚动窗 | 10 次/IP/h | `POST /analyze`（会话闸通过后再查） |

实现：每次动作前 `COUNT(*) WHERE ip_hash=? AND kind=? AND created_at > :cutoff`，超阈值即 429；未超则在动作成立后插入一行事件。事件行由 cleanup 命令保留 24h 后删除（§11）。无有效 IP（本地开发、反代未配 `X-Forwarded-For`）时该闸跳过并打 warn 日志（本地开发不受限；生产部署文档要求正确配置信任代理，见 §16-#4）。

### 3.3 第三道：Worker 侧 demo 并发闸（正式优先 + 控 token 消耗速率）

前两道在 API 侧控制"创建多少 job"，第三道在消费侧控制"demo job 同时跑几个、且不能堵住正式 job"：

1. `claimNext` 的认领排序改为**正式优先、同级 FIFO**：`ORDER BY (requester_kind='demo') ASC, created_at ASC`（`public`/未来 `user` 优先于 `demo`；SQLite/PG 双方言实现见 §8）。
2. Worker 认领后若该 job 是 demo，且当前 `running` 的 demo job 数已达建议上限 **1**（`DEMO_MAX_CONCURRENT`），则把它 `resetToQueued`（复用既有仓储方法）放回队列并短暂退避（建议 15s）后再认领——因为正式 job 排序更靠前，下一轮会先消化正式 job，demo 不会饿死正式流量。
3. MVP 阶段没有正式用户，全部是 demo 时该闸的实际效果是"demo 分析串行、最多 1 个在跑"，本身也起到保护服务端 GitHub token 消耗速率的作用，不会阻塞正常试用。

---

## 4. 秒进体验：预置快照 + 自选真实分析

两条进入路径并存：

### 4.1 预置示例账号（零外部成本、毫秒开图）

- 用 CLI `jobagent demo seed`（§11）**离线**对少量精心挑选的公开账号跑一次完整真实分析，把画像快照写入 `profiles`（与 Worker 产出结构完全一致，不造假数据），覆盖三种真实性结论形态：`likely_authentic` / `mixed_signals` / `suspicious`（或 `insufficient_data`）各一个，让新用户一次看到产品的不同判定形态。
- 预置清单是代码常量（可被 `DEMO_PRESET_LOGINS` 覆盖），新增只读端点 `GET /demo/presets`：对每个预置 `(platform, login)` 用既有 `profiles.latestBySubject` 现查 profileId，返回 `[{ platform, login, authenticity, profileId, ready }]`；seed 未跑/画像缺失时 `ready:false`，前端隐藏该项而不是报错。
- 前端点预设账号 → 直接 `POST /analyze`（anonymous 即可）→ 命中画像缓存分支（§7.3 第 2 步，先于权限检查）→ 返回 `cached:true` → 立即跳报告页。**全程不建 demo 会话、不扣任何配额、不打 GitHub。**
- 预置账号具体选谁为待拍板项（§16-#5）：从第三轮校准的 26 个账号中挑结论稳定、公开、长期存在的；负样本（suspicious）账号可能被封/改名/删库，seed 命令每次复跑校验，前端只展示 `ready:true` 的项。

### 4.2 自选真实用户名（完整真实链路，受配额）

- 用户也可以在现有 AnalyzeForm 输入任意 GitHub/Gitee 用户名。
- anonymous 提交且缓存未命中 → API 返回 403 `DEMO_REQUIRED` → 前端**自动**调 `POST /demo/sessions`（一次点击无感建会话）后**原样重试一次**分析请求；用户视角是"点了分析就开始跑"，背后完成了演示会话建立。
- 之后走真实 Worker 采集分析，受 §3 三道闸约束；配额用尽时前端把 429 渲染为"演示额度已用完，留资获取完整体验"的 waitlist 引导（落地页已有 waitlist 链路）。

---

## 5. 数据层：迁移 006–008 与仓储

遵循 [MIGRATION_CONVENTION.md](../MIGRATION_CONVENTION.md)：**一个文件只做一件事**，因此拆为 3 个连续编号迁移，sqlite/postgres 两目录各一份、编号文件名一一对应（`bash tools/check-migrations.sh` 校验集合对齐）。当前最新编号为 005，演示模式占用 **006/007/008**（若实现前有别的迁移先合入，编号顺延，以实际 `ls db/migrations/sqlite` 为准）。

### 5.1 迁移规划

| 编号 | 文件名（两侧同名） | 一件事 |
| --- | --- | --- |
| 006 | `006_create_demo_sessions.sql` | 建 demo_sessions 表 + 2 索引 |
| 007 | `007_create_demo_rate_events.sql` | 建 demo_rate_events 表 + 1 索引 |
| 008 | `008_add_requester_to_analysis_jobs.sql` | analysis_jobs 加 requester_kind、demo_session_id 两列 + 2 索引 |

### 5.2 SQLite 迁移全文（范本）

`db/migrations/sqlite/006_create_demo_sessions.sql`：

```sql
-- Migration 006: create demo_sessions table for unauthenticated demo mode
-- File: 006_create_demo_sessions.sql
-- Date: 2026-09-15 HH:mm
-- Depends on: 005
-- Ref: docs/design-demo-mode-20260915.md
-- Note: SQLite dialect. One row per temporary demo session. The id is a 43-char
--       base64url random token (prefixed 'demo-') and is also the cookie value.
--       No plaintext IP is stored, only a salted SHA-256 hash.

CREATE TABLE IF NOT EXISTS demo_sessions (
  -- session id = 'demo-' + 32 random bytes base64url; doubles as cookie value
  id               TEXT PRIMARY KEY,
  -- row created at (UTC ISO8601)
  created_at       TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  -- bumped on every authenticated action (slot acquire / me / analyze)
  last_seen_at     TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  -- absolute expiry; rows past it are treated as anonymous and purged by cleanup
  expires_at       TEXT NOT NULL,
  -- number of NEW analyses triggered in this session (cache hits do not increment)
  analyze_count    INTEGER NOT NULL DEFAULT 0,
  -- observed-only match count (no hard quota by default, see design §7.4)
  match_count      INTEGER NOT NULL DEFAULT 0,
  -- JSON array of {platform, login} for which a NEW job was created (audit/UI)
  analyzed_logins  TEXT NOT NULL DEFAULT '[]',
  -- salted SHA-256 of client IP; null when no trustworthy IP (local dev)
  ip_hash          TEXT,
  -- lifecycle: active | exited (expiry is time-based, no 'expired' status needed)
  status           TEXT NOT NULL DEFAULT 'active'
);

-- cleanup sweep by expiry
CREATE INDEX IF NOT EXISTS idx_demo_sessions_expires
  ON demo_sessions (expires_at);
-- IP sliding-window for session creation rate
CREATE INDEX IF NOT EXISTS idx_demo_sessions_ip_created
  ON demo_sessions (ip_hash, created_at);

-- DOWN BEGIN
DROP TABLE IF EXISTS demo_sessions;
-- DOWN END
```

`db/migrations/sqlite/007_create_demo_rate_events.sql`：

```sql
-- Migration 007: create demo_rate_events table for IP sliding-window limits
-- File: 007_create_demo_rate_events.sql
-- Date: 2026-09-15 HH:mm
-- Depends on: 006
-- Ref: docs/design-demo-mode-20260915.md §3.2
-- Note: SQLite dialect. Append-only counters; cleanup deletes rows older than 24h.
--       Storing window counters in DB avoids introducing Redis in the MVP.

CREATE TABLE IF NOT EXISTS demo_rate_events (
  -- event id (uuid)
  id               TEXT PRIMARY KEY,
  -- salted SHA-256 of client IP
  ip_hash          TEXT NOT NULL,
  -- rate-limit bucket: session | analyze
  kind             TEXT NOT NULL,
  -- event time (UTC ISO8601)
  created_at       TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

-- sliding-window count: WHERE ip_hash=? AND kind=? AND created_at > cutoff
CREATE INDEX IF NOT EXISTS idx_demo_rate_events_ip_kind_created
  ON demo_rate_events (ip_hash, kind, created_at);

-- DOWN BEGIN
DROP TABLE IF EXISTS demo_rate_events;
-- DOWN END
```

`db/migrations/sqlite/008_add_requester_to_analysis_jobs.sql`：

```sql
-- Migration 008: add requester columns to analysis_jobs for demo mode
-- File: 008_add_requester_to_analysis_jobs.sql
-- Date: 2026-09-15 HH:mm
-- Depends on: 002, 006
-- Ref: docs/design-demo-mode-20260915.md §5/§8
-- Note: SQLite dialect. Historical/CLI rows stay 'public' via constant default,
--       so existing behaviour is unchanged. ADD COLUMN with constant NOT NULL
--       DEFAULT is valid in SQLite. No hard FK (sessions may be purged).

-- requester identity class: public (CLI/anonymous-era default) | demo | user(reserved)
ALTER TABLE analysis_jobs ADD COLUMN requester_kind TEXT NOT NULL DEFAULT 'public';
-- owning demo session id when requester_kind='demo'; null otherwise
ALTER TABLE analysis_jobs ADD COLUMN demo_session_id TEXT;

-- Worker priority ordering (formal first) and demo concurrency count
CREATE INDEX IF NOT EXISTS idx_analysis_jobs_requester_status
  ON analysis_jobs (requester_kind, status);
-- scope "jobs created by this demo session"
CREATE INDEX IF NOT EXISTS idx_analysis_jobs_demo_session
  ON analysis_jobs (demo_session_id);

-- DOWN BEGIN
-- SQLite 3.35+ supports DROP COLUMN (bundled in current better-sqlite3);
-- executed at most once during rollback, hence no IF EXISTS.
ALTER TABLE analysis_jobs DROP COLUMN demo_session_id;
ALTER TABLE analysis_jobs DROP COLUMN requester_kind;
-- DOWN END
```

### 5.3 Postgres 对应迁移要点

`db/migrations/postgres/006_create_demo_sessions.sql`、`007_...`、`008_...`：列集合、类型、索引名与 SQLite **逐一对齐**（既有 parity 测试会守护），差异仅：

- 文件头加 `-- Dialect: Postgres`；布尔没有（本设计无新布尔列）；时间列仍统一 TEXT/ISO8601 字符串（与现有 5 个迁移保持一致，PG 侧 TIMESTAMPTZ 仍缓做）。
- 每张表、每列补 `COMMENT ON TABLE/COLUMN`（照 005 PG 版格式）。
- 008 用幂等加列写法：

  ```sql
  ALTER TABLE analysis_jobs ADD COLUMN IF NOT EXISTS requester_kind TEXT NOT NULL DEFAULT 'public';
  ALTER TABLE analysis_jobs ADD COLUMN IF NOT EXISTS demo_session_id TEXT;
  ```

  DOWN 段为 `ALTER TABLE analysis_jobs DROP COLUMN IF EXISTS demo_session_id;` / `... DROP COLUMN IF EXISTS requester_kind;`。

### 5.4 entities 与仓储契约

新增 `packages/storage/src/entities/demo-session.ts`（方言无关领域类型 + 行映射纯函数，照 `entities/analysis-job.ts` 的 `RawRow → toStored` 模式）：

```ts
export type DemoSessionStatus = 'active' | 'exited';
export type DemoRateKind = 'session' | 'analyze';

export interface NewDemoSession {
  id: string;
  expiresAt: string;
  ipHash: string | null;
}

export interface StoredDemoSession {
  id: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  analyzeCount: number;
  matchCount: number;
  analyzedLogins: Array<{ platform: 'github' | 'gitee'; login: string }>;
  ipHash: string | null;
  status: DemoSessionStatus;
}

export type DemoSlotResult =
  | { granted: true; used: number; remaining: number }
  | { granted: false; reason: 'not_found' | 'expired' | 'exited' | 'quota_exceeded'; used: number };
```

新增 `packages/storage/src/repositories/demo-sessions.ts`：

```ts
export interface IDemoSessionsRepository {
  create(session: NewDemoSession): Promise<void>;
  /** Active 且未过期才返回；status=exited/过期返回 undefined */
  getActive(id: string, now: string): Promise<StoredDemoSession | undefined>;
  /** 原子名额扣减（§3.1）：单条条件 UPDATE，禁止 select-then-update */
  acquireAnalyzeSlot(id: string, quota: number, now: string): Promise<DemoSlotResult>;
  /** 仅用于"扣名额成功但 jobs.create 失败"的补偿；正常分析失败不回补 */
  releaseAnalyzeSlot(id: string): Promise<void>;
  /** match 计数 +1（观测用，无上限判定） */
  incrementMatch(id: string, now: string): Promise<void>;
  /** 刷新 last_seen_at 并追加 analyzed_logins（去重，上限保留最近 20 条） */
  touch(id: string, now: string, login?: { platform: 'github' | 'gitee'; login: string }): Promise<void>;
  exit(id: string, now: string): Promise<void>;

  // ── IP 滑动窗口（§3.2）──
  countRateEvents(ipHash: string, kind: DemoRateKind, since: string): Promise<number>;
  insertRateEvent(ipHash: string, kind: DemoRateKind, now: string): Promise<void>;

  // ── CLI cleanup（§11）──
  /** 删除 exited 且超过保留期、或已过期超过保留期的会话；返回删除行数 */
  purgeExpired(now: string, retainMs: number): Promise<number>;
  /** 删除 created_at 早于 cutoff 的限流事件；返回删除行数 */
  purgeRateEventsBefore(cutoff: string): Promise<number>;
}
```

**原子扣减的双方言实现要点**（业务代码只调接口，方言差异只出现在这两个文件里）：

- SQLite（`sqlite/demo-sessions-repo.ts`，better-sqlite3 同步 Drizzle，风格照现有 `claimNext`）：

  ```ts
  const result = this.db
    .update(demoSessions)
    .set({ analyzeCount: sql`${demoSessions.analyzeCount} + 1`, lastSeenAt: now })
    .where(
      and(
        eq(demoSessions.id, id),
        eq(demoSessions.status, 'active'),
        gt(demoSessions.expiresAt, now),
        sql`${demoSessions.analyzeCount} < ${quota}`,
      ),
    )
    .run();
  if ((result.changes ?? 0) === 1) {
    const row = this.db.select().from(demoSessions).where(eq(demoSessions.id, id)).get();
    // → { granted: true, used: row.analyzeCount, remaining: quota - row.analyzeCount }
  }
  // changes=0 时再查一次行，区分 not_found / expired / exited / quota_exceeded（错误码精度需要）
  ```

- Postgres（`postgres/demo-sessions-repo.ts`，async Drizzle）：用 `.returning()` 一条语句拿到扣后值，无需两次往返：

  ```ts
  const rows = await this.db
    .update(demoSessions)
    .set({ analyzeCount: sql`${demoSessions.analyzeCount} + 1`, lastSeenAt: now })
    .where(/* 同上四个条件 */)
    .returning({ analyzeCount: demoSessions.analyzeCount, status: demoSessions.status, expiresAt: demoSessions.expiresAt });
  // rows.length === 1 → granted；0 → 补查区分拒绝原因
  ```

### 5.5 analysis_jobs 实体与仓储的连带修改

- `entities/analysis-job.ts`：
  - `NewAnalysisJob` 增加可选 `requesterKind?: RequesterKind`（缺省 `'public'`）、`demoSessionId?: string | null`；
  - `StoredAnalysisJob` 增加 `requesterKind: RequesterKind`、`demoSessionId: string | null`；
  - `RawAnalysisJobRow` + `toStoredJob` 补两列映射（snake_case → camelCase 只在持久化层转换）。
- `sqlite/analysis-jobs-repo.ts` 与 `postgres/analysis-jobs-repo.ts`：`create` 的 INSERT 补两列（缺省值 `'public'`/null，保证既有调用与全部既有测试不改即绿）。
- **`claimNext` 排序键修改**（§3.3）：最老 queued 的选取从"仅按 created_at"改为"正式优先（requester_kind='demo' 排后）再按 created_at"，事务两步法（SELECT id → UPDATE 特定 id 双校验）不变：
  - SQLite：`.orderBy(sql`CASE WHEN ${analysisJobs.requesterKind} = 'demo' THEN 1 ELSE 0 END`, asc(analysisJobs.createdAt))`；
  - Postgres：async 事务内同样语义。
- **新增 `IAnalysisJobsRepository.countRunningByRequesterKind(kind)`**（Worker 并发闸 §3.3/§8 使用；查的是 analysis_jobs，故归 jobs 仓储而非 demoSessions 仓储）：双方言各一条 `SELECT COUNT(*) ... WHERE status='running' AND requester_kind=?`，返回 number。
- 双方言 `schema.ts` 补 `demoSessions`、`demoRateEvents` 表定义与 analysis_jobs 两列，列名/类型与迁移严格一致。

### 5.6 装配清单（storage 包内，照 005/jobPostings 的落地路径）

1. `repositories/index.ts` 导出 `IDemoSessionsRepository` 及实体类型；
2. `entities/index.ts` 导出 demo-session 实体；
3. `types.ts` 的 `StorageContext` 增加 `demoSessions: IDemoSessionsRepository;`；
4. `sqlite/`、`postgres/` 各加 `demo-sessions-repo.ts`，并在两侧工厂（`storage.ts` / 连接装配处）实例化注入；
5. 包根 `index.ts` 导出新接口与类型；
6. 既有 schema 一致性测试、迁移文本一致性测试会自动对 006–008 提出对齐要求，需同步补预期；`migrations.test.ts` 补三表/两列存在断言；PG 行为套件在 `DATABASE_TEST_URL`/embedded-postgres 下覆盖原子扣减与并发语义。

---

## 6. shared 契约（packages/shared/src/index.ts）

紧邻现有 `PlatformSchema`（约 69 行）新增，全部 Zod 定义 + 推导类型，作为 API/Worker/report/extension 共享的单一事实源：

```ts
// ── Requester principal（演示模式，design-demo-mode-20260915）──
export const REQUESTER_KINDS = ['anonymous', 'demo', 'user'] as const;
export const RequesterKindSchema = z.enum(REQUESTER_KINDS);
export type RequesterKind = z.infer<typeof RequesterKindSchema>;
// 'user' is reserved for the future accounts milestone and is never produced today.

export const DEMO_RATE_KINDS = ['session', 'analyze'] as const;
export const DemoRateKindSchema = z.enum(DEMO_RATE_KINDS);

/** GET /demo/me 响应体契约 */
export const DemoMeSchema = z.object({
  kind: RequesterKindSchema,
  // 仅 kind='demo' 时存在
  sessionId: z.string().optional(),
  expiresAt: z.string().optional(),
  analyzeQuota: z.number().int().nonnegative().optional(),
  analyzeUsed: z.number().int().nonnegative().optional(),
  analyzeRemaining: z.number().int().nonnegative().optional(),
});
export type DemoMe = z.infer<typeof DemoMeSchema>;

export const DemoPresetSchema = z.object({
  platform: PlatformSchema,
  login: z.string(),
  authenticity: z.string(), // AuthenticityStatus，但缺失时允许 unknown
  profileId: z.string().nullable(),
  ready: z.boolean(),
});
export type DemoPreset = z.infer<typeof DemoPresetSchema>;
```

错误码常量也放 shared（前后端共用，避免前端硬编码字符串）：

```ts
export const DEMO_ERROR_CODES = {
  demoRequired: 'DEMO_REQUIRED',        // 403：匿名触发新分析
  quotaExceeded: 'DEMO_QUOTA_EXCEEDED', // 429：会话配额用尽
  rateLimited: 'DEMO_RATE_LIMITED',     // 429：IP 窗口超限
} as const;
export type DemoErrorCode = (typeof DEMO_ERROR_CODES)[keyof typeof DEMO_ERROR_CODES];
```

新增对应 Zod 契约单测（合法/非法枚举、DemoMe 匿名最小形态、demo 完整形态）。

---

## 7. API 层（apps/api）

### 7.1 Principal 解析

新增 `apps/api/src/principal.ts`（薄 I/O + 纯解析，便于单测）：

```ts
export const DEMO_COOKIE = 'jobagent_demo';

/** 从 Cookie 解析当前 Principal；坏/过期会话静默降级 anonymous */
export async function resolvePrincipal(
  cookieHeader: string | undefined,
  demoSessions: IDemoSessionsRepository,
  now: () => string,
): Promise<Principal> {
  const token = cookieHeader ? getCookie({ raw: cookieHeader } as never, DEMO_COOKIE) : undefined;
  // 用 hono/cookie 的 getCookie(c, name) 亦可；抽纯函数时直接解析 document.cookie 风格字符串
  if (!token) return { kind: 'anonymous' };
  const session = await demoSessions.getActive(token, now());
  if (!session) return { kind: 'anonymous' };
  return {
    kind: 'demo',
    sessionId: session.id,
    analyzeCount: session.analyzeCount,
    matchCount: session.matchCount,
    expiresAt: session.expiresAt,
  };
}

/** 取可信客户端 IP：生产在反代后读 X-Forwarded-For 首段；本地直连无代理返回 null */
export function clientIp(c: Context, trustProxy: boolean): string | null { /* ... */ }

/** salted SHA-256；salt 来自 DEMO_IP_SALT（§12/§13） */
export function hashIp(ip: string, salt: string): string { /* node:crypto sha256(salt + ':' + ip) hex */ }
```

在 `createApp` 内、CORS 之后、业务路由之前注册全局中间件：

```ts
app.use('*', async (c, next) => {
  c.set('principal', await resolvePrincipal(c.req.header('Cookie'), repos.demoSessions, now));
  await next();
});
```

> `ApiRepos`（index.ts 53 行）需增加 `demoSessions: IDemoSessionsRepository`；`createStorage()` 生产路径自动具备。现有集成测试注入的 fake repos 需补一个内存 fake（或测试辅助工厂统一生成）。

### 7.2 /demo/* 三端点（注册在 /analyze 之前）

**POST /demo/sessions**（无请求体或空对象）：

1. 若当前已是有效 demo → 200 直接回当前 `DemoMe`（幂等，不重复建、不重复占 IP 窗口）；
2. 算 ipHash；非空则先 `countRateEvents(ip,'session',1h 前)`，≥ 阈值 → 429 `DEMO_RATE_LIMITED`（body 带 `retryAfterSeconds`）；
3. `id = 'demo-' + randomBytes(32).toString('base64url')`（node:crypto，不用可猜序号）；`expiresAt = now + DEMO_SESSION_TTL_MS`；`demoSessions.create(...)`；插入一条 `session` 限流事件；
4. `setCookie(c, DEMO_COOKIE, id, cookieAttrs)`（属性见 §7.6）；
5. 201 返回 `DemoMe`（kind=demo、quota、remaining=quota）。

**GET /demo/me**：把 `c.get('principal')` 序列化为 `DemoMe`（anonymous 回 `{kind:'anonymous'}`；demo 回配额状态，quota 从配置读）。

**GET /demo/presets**：§4.1，逐预设项查 `profiles.latestBySubject`，返回 `DemoPreset[]`（只读、公开、无需 demo 身份）。

**POST /demo/exit**：demo 则 `demoSessions.exit(...)`；`deleteCookie`（同属性）；回 `{kind:'anonymous'}`。anonymous 调它是 no-op 200。

### 7.3 POST /analyze 改造（替换现有 186–238 行处理体）

顺序是本设计的关键，**画像缓存必须先于身份/配额检查**：

```text
1. JSON parse + AnalyzeRequestSchema 校验                       （不变，400）
2. profiles.latestBySubject 查未过期 complete 快照
   命中 → 直接 200 { profileId, status:'succeeded', cached:true }  ← 任何身份都放行、不扣配额
3. principal = c.get('principal')
   if principal.kind === 'anonymous'
     → 403 { error:'DEMO_REQUIRED', code, message }             （前端据此自动建会话重试）
   // user 分支：reserved，本次不存在
4. demo：
   a. jobs.latestActiveBySubject 去重检查先做：已有 active job
      → 200 { jobId, dedup:true }（不扣任何配额，直接复用）
   b. IP analyze 窗口：countRateEvents(ip,'analyze',1h) ≥ 阈值
      → 429 DEMO_RATE_LIMITED
   c. acquireAnalyzeSlot(sessionId, quota, now)
      granted=false(quota_exceeded) → 429 DEMO_QUOTA_EXCEEDED
        body: { code, analyzeQuota, analyzeUsed, analyzeRemaining:0, resetAt: session.expiresAt }
   d. insertRateEvent(ip,'analyze')
   e. try jobs.create({
        id: 'job-'+randomUUID(), subjectPlatform: platform, subjectLogin: username,
        requesterKind: 'demo', demoSessionId: sessionId,
      })
      catch → releaseAnalyzeSlot(sessionId) 补偿后 500
   f. demoSessions.touch(sessionId, now, {platform, login: username})
   g. 201 { jobId, status:'queued', dedup:false, demo:{ remaining } }
```

注意与现状的两处行为差异，均为有意：

- 现状匿名可直接建 job（无闸）；改造后匿名新分析被 403 拦截——CLI 不走 HTTP 不受影响，落地页/报告页前端统一按 §9 处理 403。
- active 去重从"缓存之后第二顺位"调整为"demo 配额扣减之前"，避免"别人/自己刚触发过同一人、任务还在跑"也白扣一次配额。

### 7.4 其他端点策略

- `POST /job-postings/match`：保持公开可用（anonymous 放行）。demo 调用时 `incrementMatch` 仅观测、不拦截。IP 窗口统一兜底（建议 60 次/h/IP，远高于正常使用，只挡脚本刷库）。**是否改为会话硬配额列为待拍板项**（§16-#1 末），仓储已预留 `acquireMatchSlot` 的对称扩展位，本次先只做 `incrementMatch`。
- 全部 GET 只读端点（profiles/exportable/job-recommendations/job-postings/jobs 轮询/health）**不加身份、不加配额**。
- `formatJob` 可附带 `requester: { kind: job.requesterKind }`（不带 sessionId 出站，避免会话 token 出现在日志/响应里——sessionId 本身就是 Cookie 凭证，响应只回当前用户自己的 /demo/me，不回在 job 对象上）。

### 7.5 错误码与响应体

| HTTP | code | 触发 | body 关键字段 | 前端动作 |
| --- | --- | --- | --- | --- |
| 403 | `DEMO_REQUIRED` | 匿名且缓存未命中触发新分析 | code, message | 自动建会话并重试一次 |
| 429 | `DEMO_QUOTA_EXCEEDED` | 会话分析次数用尽 | analyzeQuota/used/remaining=0/resetAt | 展示剩余说明 + waitlist 引导 |
| 429 | `DEMO_RATE_LIMITED` | IP 窗口超限 | retryAfterSeconds, bucket | 倒计时提示，稍后再试 |

错误响应沿用现有 `{ error, ... }` 形态并增加稳定的 `code` 字段（既有 400/404 不变）；docs/API.md 实现时补这三个端点与错误码章节。

### 7.6 Cookie 属性、CORS 与部署形态（关联待拍板 #4）

Cookie 统一属性：

```text
HttpOnly          （JS 读不到，降低 XSS 窃取会话风险）
SameSite=Lax      （顶层导航能带、跨站 POST 不带；演示无状态修改动作，Lax 足够，不另建 CSRF token，威胁模型见 §12）
Path=/
Secure            （仅生产 HTTPS；本地 http 经 NODE_ENV!=='production' 关闭，否则 localhost 写不进）
Max-Age = TTL     （与 expires_at 一致，建议 7d）
```

**关键约束：现有 CORS 是 `origin:'*'`（index.ts 174–178），而跨域 `fetch(...,{credentials:'include'})` 不允许 ACAO 为 `*`。** 两种部署形态：

- **形态 A（推荐）：同域反向代理**。报告页与 API 部署在同一站点（如 `app.example.com/` 页面、`app.example.com/api/*` 反代到 API 服务），前端用相对路径同源请求，Cookie 天然携带，无需改 CORS。落地页静态站若也同域更佳。
- **形态 B：跨子域/跨域**（如页面 `*.bayjf.com`、API 独立域）：必须把 `cors()` 改为 origin 白名单函数（回显具体 Origin 而非 `*`）+ `credentials:true`，前端所有对 API 的 fetch 加 `credentials:'include'`；Cookie 的 `Domain` 按是否跨子域设置（同父域可设 `Domain=.example.com`，跨站则完全无法共享 Cookie，只能走形态 A）。

本设计代码按"同源可用、跨域可配"写：cookie 逻辑不依赖形态，CORS 白名单从环境变量 `CORS_ALLOW_ORIGINS`（逗号分隔）读取，缺省保持现状宽松但**不发 Cookie 凭证**；形态选择与生产域名是 §16-#4 待拍板项，拍板前不把某一形态写成既定事实。

---

## 8. Worker（apps/worker）

只改调度层，**采集分析主流程 processJob 一行不改**（demo 跑的是真实 GitHubSource/GiteeSource → analyze，不 mock）：

1. `processJob` 签名不变；它从 `job.requesterKind` 能读到身份但无需据此分支（所有身份产出画像的路径一致）。日志可多打一行 `requester=${job.requesterKind}` 便于观察 demo 占比。
2. `runWorker` 主循环认领后加并发闸（伪代码）：

   ```ts
   const job = await repos.jobs.claimNext(workerId);
   if (!job) { await sleep(poll); continue; }
   if (job.requesterKind === 'demo') {
     const demoRunning = await repos.jobs.countRunningByRequesterKind('demo'); // 含刚 claim 的这一个（IAnalysisJobsRepository，§5.5）     if (demoRunning > DEMO_MAX_CONCURRENT) {
       await repos.jobs.resetToQueued(job.id, 'demo concurrency cap, requeued behind formal jobs');
       logger.info(`[worker] demo cap reached (${demoRunning}), requeue ${job.id} and back off`);
       await sleep(DEMO_BACKOFF_MS); // 建议 15000
       continue;
     }
   }
   await processJob(job, repos, sources, logger); // 既有成功/失败处理不变
   ```

   > `countRunningByRequesterKind` 放 `IAnalysisJobsRepository`（不是 demoSessions 仓储——它查的是 analysis_jobs），§5.4 接口清单中该方法位置以此为准修正：属 jobs 仓储。双方言各一条 `SELECT COUNT(*) ... WHERE status='running' AND requester_kind=?`。
3. `claimNext` 正式优先排序见 §5.5；这样被放回队尾的 demo 不会挡住后来的 public/user job。
4. 现有失败重试（attempts<3、not_found 不重试）对 demo 一视同仁：demo job 失败也只重试 3 次，**已扣的会话名额不回补**（采集可能已实际消耗外部配额）。
5. WorkerDeps 增加 `demoMaxConcurrent?`、`demoBackoffMs?` 注入点（默认读环境变量），便于单测构造"cap=1、两个 demo job 串行/正式插队"场景。

---

## 9. Report 前端（apps/report）

全部新文案走 i18n `t()`、新样式只用 `var(--ja-*)`，遵守两份 design 文档的硬约束。

### 9.1 新增 DemoBanner island

`components/DemoBanner.tsx`（`client:load`）：

- 挂载即调 `GET {apiBase}/demo/me`（`credentials:'include'`）；
- `kind!=='demo'` 时渲染 null（匿名无横幅，避免打扰）；
- demo 时展示一条浅色横幅：「演示模式 · 还可分析 N 个账号 · 额度于 X 重置 · 退出演示」；退出按钮调 `POST /demo/exit` 后局部刷新为匿名态；
- 文案全部由 Astro SSR 经 props 传入（与 AnalyzeForm 同模式，组件不硬编码用户可见字符串），时间用现有 `lib/format.ts` 的 Intl 按 locale 格式化；
- SSR 首屏（可选、避免横幅闪烁）：`[locale]/index.astro` 与报告页 layout 在服务端把收到的 Cookie 转发给 API `/demo/me`（服务端 fetch，失败静默按 anonymous），把结果作为 initial prop 给 island；island 挂载后再校验一次。

### 9.2 首页演示入口（[locale]/index.astro）

- 在 AnalyzeForm 卡片内或下方加「没有目标账号？先看示例」区块：挂载时取 `GET /demo/presets`，渲染 3 个预设按钮（展示平台 + login + 真实性结论词）；点击 = 把该 login/platform 填入 AnalyzeForm 并走既有提交逻辑（缓存秒回跳报告页，§4.1）。预设未 ready 时不渲染。
- 主 CTA「分析」保持现有功能不变，不强制先点演示。

### 9.3 AnalyzeForm 改造（components/AnalyzeForm.tsx）

- 所有 `fetch(apiBase...)` 加 `credentials: 'include'`（同源无害、跨域必需）。
- POST /analyze 响应分支新增：
  - **403 DEMO_REQUIRED**：自动 `POST /demo/sessions`（一次）→ 成功后重放原 /analyze 一次；若建会话也失败则落 error 态展示文案；整个自动重试只做一次，避免循环。
  - **429 DEMO_QUOTA_EXCEEDED**：error 区展示 `demo.quotaExceeded` 文案 + 「加入 waitlist」按钮（链接到落地页留资锚点，URL 走配置/常量，不硬编码死链）。
  - **429 DEMO_RATE_LIMITED**：展示 `demo.rateLimited`（含"稍后再试"，可用 retryAfterSeconds 做最简倒计时，也可只展示静态文案）。
- 新增 props（沿用现有"SSR 传文案"模式）：上述三类文案 + 预设区块文案 + 平台无关措辞。

### 9.4 i18n key（zh-CN.json / en.json 同构新增，key 对齐测试自动守护）

建议 key 组（命名与现有 `home.*`/`job.*` 平级）：

```text
demo.banner.title        演示模式 / Demo mode
demo.banner.remaining    还可分析 {count} 个账号 / You can analyze {count} more account(s)
demo.banner.resetAt      额度重置：{time} / Limit resets: {time}
demo.banner.exit         退出演示 / Exit demo
demo.presets.heading     先看示例账号 / Try a sample account
demo.presets.suffix      （秒开，不消耗额度） / (instant, no quota used)
demo.quotaExceeded       演示额度已用完，留资以获取完整体验 / Demo quota used up — join the waitlist for full access
demo.waitlistCta         加入候补名单 / Join the waitlist
demo.rateLimited         操作过于频繁，请 {seconds} 秒后再试 / Too many requests, try again in {seconds}s
demo.establishing        正在进入演示… / Starting demo…
```

### 9.5 样式与 E2E

- 横幅/预设按钮/错误态样式全部使用 `var(--ja-space-*)`、`var(--ja-color-*)` 等既有 token，**禁止 hex/硬编码尺寸**；需要新色彩（如演示提示底色）先在 `packages/ui-tokens/tokens.css` 加语义 token 再引用，不在组件里造值。
- E2E（`e2e/`，page.route mock，照现有 job-recommendations.spec 模式）补：①匿名点预设→mock cached→跳报告页；②匿名分析→mock 403→建会话→重试成功；③429 配额文案与 waitlist 按钮；④Banner demo 态渲染与退出。report dev server 继续带 `--no-toolbar`。

---

## 10. 浏览器扩展边界（apps/extension）

**扩展不引入演示会话、不携带 jobagent_demo Cookie**：

- content script 运行在第三方 ATS（Greenhouse/Lever/Workday）页面，向 JobAgent API 发的是跨站请求；让浏览器在第三方站点带上我们的演示 Cookie 既没有功能收益（面板只消费 `GET /profiles/:id/exportable` 公开端点），又扩大 Cookie 暴露面。
- 扩展侧保持现状：按 login/platform 拉公开 exportable 画像，不触发分析（它本来就不调 POST /analyze）。
- 唯一新增：扩展面板加一个普通外链「在网页端试用完整演示」，新标签打开报告页首页（`EXTENSION_*` 配置同源地址）；新增 1–2 个 i18n key（中英）、样式走 token，不加任何鉴权逻辑。

---

## 11. CLI：demo seed / cleanup（apps/cli）

照现有命令分发（`run()` 内 `if (command === ...)`，jobs 委托 `runJobs` 的模式）新增 `demo` 子命令，Usage 行同步更新：

### 11.1 `jobagent demo seed`

- 读取预置清单（代码常量或 `--logins a,b` / `DEMO_PRESET_LOGINS`，`--platform github|gitee|all` 默认 github）。
- 对每个 login 走**与 Worker 完全相同**的采集 + analyze 路径（复用 CLI 既有 analyze 依赖注入，不复制分析逻辑），再经 `profiles` 仓储写入快照（等价 Worker 产出）；幂等：已存在未过期 complete 快照则跳过并打印 `skip (fresh)`，`--force` 强制重跑。
- 结束打印每个账号的 profileId/authenticity/ready，供把结果核对进预设清单；**不写入任何 demo_sessions**（seed 是离线备料，不是会话）。
- 需要本地持有 GITHUB_TOKEN/GITEE_TOKEN（与现有 CLI analyze 一致），是开发者侧命令。

### 11.2 `jobagent demo cleanup`

- `demoSessions.purgeExpired(now, retainMs)`（删除已过期/已退出且超过保留期的会话，默认保留期 24h 便于排查）；
- `demoSessions.purgeRateEventsBefore(now-24h)`；
- 打印两类删除行数，退出码 0；存储不可用退出 1（照 waitlist 子命令的错误处理）。
- **定时**：生产按 [design-job-ingestion-20260913.md](design-job-ingestion-20260913.md) §7.3 的既有 cron 模式，每日一次，例如 Linux cron：

  ```cron
  30 3 * * * cd /srv/job-agent && pnpm --filter @jobagent/cli start demo cleanup >> /var/log/jobagent-demo-cleanup.log 2>&1
  ```

  Windows schtasks 等价条目实现时补；MVP 本地不跑也不影响正确性（过期会话在读取时即被视为 anonymous，cleanup 只是空间回收）。

### 11.3 测试

- seed：注入 fake source/storage，验证幂等跳过、--force 重跑、清单解析、坏账号容错不中断；
- cleanup：fake 仓储验证 cutoff 计算与退出码；未知 demo 子命令/非法参数 exit 2（照现有 CLI 约定）。

---

## 12. 安全与隐私

1. **会话令牌不可猜**：`crypto.randomBytes(32).toString('base64url')`（256 bit 熵），不用自增 id/UUIDv4 以外的可预测值；令牌只存于 HttpOnly Cookie 与服务端行，不出现在 URL、不写 access log、不进 job 响应体。
2. **不存明文 IP**：只存 `sha256(DEMO_IP_SALT + IP)` hex；salt 走环境变量（§13），不入库不入 Git；未配置 salt 时启动生成进程内随机 salt（重启后旧窗口计数失效，限频略弱但绝不裸奔），并打一次 warn 提示生产配置。
3. **越权防护**：任何"读/写自己会话"的仓储方法都把 `sessionId` 作为必填 WHERE 条件（接口签名层面强制，code review 清单逐项核对）；不提供"列出某会话全部 job"之外的批量枚举面——实际上本次不新增任何会话维度的列表端点，`GET /jobs/:id` 保持公开（状态信息无个人数据）。
4. **配额防绕过的边界**：清 Cookie 受 IP 建会话/分析双窗口约束；换 IP（代理池/肉鸡）超出 MVP 威胁模型，不提前构建复杂对抗，上线后依据 cleanup/日志观察到的真实滥用模式再加（如 ASN 限频、验证码），并登记为 deferred 触发项。
5. **CSRF**：演示会话能做的唯一"写动作"是触发公开账号分析（无资金、无个人数据写入、无状态破坏），`SameSite=Lax` 已阻断跨站 POST 自动带 Cookie；不引入完整 CSRF token 体系。未来 `user` 账号体系上线时必须重新评估并升级（写入 deferred，触发条件=账号体系立项）。
6. **Cookie 安全属性**见 §7.6；生产必须 HTTPS + 正确配置信任代理（否则 clientIp 为 null，IP 闸失效）。
7. **数据最小化**：demo_sessions 不存邮箱/用户名等任何 PII（analyzed_logins 只存被分析的**公开平台账号名**，非用户自身信息）；会话 TTL 后由 cleanup 清除。
8. **不 clone、不执行被分析仓库代码**等既有安全约束不变；演示模式不改变 GitHub/Gitee 凭证只在服务端的约束。

---

## 13. 环境变量（实现时同步 .env.example，带默认值与说明）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `DEMO_SESSION_TTL_MS` | `604800000`（7 天，建议值待拍板） | 演示会话有效期，同时是 Cookie Max-Age |
| `DEMO_ANALYZE_QUOTA` | `3`（建议值待拍板） | 单会话可触发的新分析次数 |
| `DEMO_SESSION_RATE_PER_HOUR` | `5` | 单 IP 每小时建会话上限 |
| `DEMO_ANALYZE_RATE_PER_HOUR` | `10` | 单 IP 每小时触发分析上限 |
| `DEMO_MATCH_RATE_PER_HOUR` | `60` | match 只读计算的 IP 兜底窗口 |
| `DEMO_MAX_CONCURRENT` | `1` | Worker 同时运行的 demo job 上限 |
| `DEMO_BACKOFF_MS` | `15000` | demo 并发闸触发后的退避毫秒 |
| `DEMO_IP_SALT` | 空（进程内随机，生产必填） | IP 哈希盐，见 §12-2 |
| `DEMO_PRESET_LOGINS` | 空（用代码常量） | 覆盖预置示例清单，形如 `github:torvalds,github:bayernjf` |
| `CORS_ALLOW_ORIGINS` | 空（保持现状） | 跨域部署形态 B 时的 Origin 白名单，见 §7.6 |
| `TRUST_PROXY` | `false` | 生产反代后置 true，才从 X-Forwarded-For 取 IP |

配置读取集中在一个 `apps/api/src/demo-config.ts`（纯函数，环境变量 → 带默认值/边界裁剪的配置对象，非法值回退默认并 warn），便于单测，不在各端点散落 `process.env`。

---

## 14. 测试清单（确定性，零真实网络）

**shared（+约 4）**：RequesterKind/DemoMe/DemoPreset schema 合法与拒绝；错误码常量稳定。

**storage（+约 14，双方言）**：
- create → getActive 命中；exited/过期/不存在 → undefined；
- acquireAnalyzeSlot：第 1..N 次 granted 且 used/remaining 正确；第 N+1 次 quota_exceeded；过期/exited 拒绝；release 补偿后可再拿；
- **并发语义**：同一 session 同步连续调用 N+2 次（SQLite 事务串行）只放行 N 次（这是防超用的核心回归）；PG 行为套件用 Promise 并发验证；
- rate events 窗口计数随 cutoff 变化；purge 两方法行数正确；
- countRunningByRequesterKind；analysis_jobs 新列默认 'public'/null；claimNext 正式优先排序（构造 public+demo 混合队列断言认领顺序）；
- 006–008 进 migrations 测试（干净库顺序 up/down、编号连续、表列存在），双方言 parity 测试补 006–008 对齐；PG 行为套件在 embedded-postgres 实跑。

**api（+约 16，注入 fake repos，照现有 index.test.ts）**：
- POST /demo/sessions：201 + Set-Cookie 含 HttpOnly/SameSite/Max-Age；重复调用幂等不新建；IP 超限 429；
- GET /demo/me：无 Cookie anonymous、坏 Cookie 降级、有效 Cookie 回配额；
- POST /demo/exit：置 exited + 清 Cookie；匿名 no-op；
- GET /demo/presets：ready/缺失混合；
- POST /analyze：①匿名缓存命中放行不建会话；②匿名缓存未命中 403 DEMO_REQUIRED；③demo 缓存命中不扣次数（acquire 零调用）；④active 去重不扣次数；⑤demo 配额内 201 且 job 带 requesterKind/demoSessionId、touch 被调；⑥第 N+1 次 429 带 resetAt；⑦IP analyze 窗 429；⑧create 抛错时名额补偿释放；
- 既有全部端点测试保持绿（新列默认值保证不破坏）。

**worker（+约 4）**：cap 内正常跑；cap 满 resetToQueued + 退避；public 插队优先于 demo；processJob 对 demo/public 行为一致（回归）。

**report**：i18n key 中英对齐（现有守护自动覆盖新 key）；DemoBanner 四态单测/组件测试；AnalyzeForm 403 自动建会话重试一次、429 分支；E2E +4（§9.5）。

**extension（+约 1）**：外链入口存在与 i18n；确认不发 Cookie、不新增 /analyze 调用。

**cli（+约 5）**：seed 幂等/--force/容错；cleanup cutoff 与退出码；Usage 与非法子命令 exit 2。

**门禁**：`pnpm -r typecheck` + `pnpm -r test` + `pnpm -r build` + `bash tools/check-migrations.sh` + `git diff --check`；E2E（report + extension）全绿。

---

## 15. 原子提交规划（实现阶段，Conventional Commits 英文，一提交一事）

> 设计文档本身先行单独提交（`docs`）。以下为拍板后的实现顺序，每步独立可回滚、每步结束三件套全绿；严格不在前一步缺失时跳步。

1. `feat(shared): add requester principal and demo contracts` — §6 全部 schema/类型/错误码 + 单测。
2. `feat(db): add demo mode migrations 006-008 in both dialects` — 6 个 SQL 文件（3×2 方言），migrations/parity 测试先适配到红，下一步转绿。
3. `feat(storage): add demo sessions repository and job requester columns` — entities/双方言仓储/schema/工厂装配/StorageContext/claimNext 优先排序/测试。
4. `feat(api): add demo sessions endpoints and quota-gated analyze` — principal 中间件、/demo/*、/analyze 改造、demo-config、错误码、API.md、测试。
5. `feat(worker): prioritize formal jobs and cap demo concurrency` — §8 调度闸 + 测试。
6. `feat(report): add demo banner, presets and quota error handling` — DemoBanner、首页预设、AnalyzeForm 分支、i18n 中英 key、token 样式、E2E。
7. `feat(extension): link to web demo from the panel` — §10 外链 + i18n（很小，可与 6 合并视改动量，但默认独立）。
8. `feat(cli): add demo seed and cleanup commands` — §11 + .env.example 登记。
9. `docs: record demo mode rollout in handoff and docs map` — handoff 回写、docs/README、AGENTS 相关结构/约束更新（若涉及）。

---

## 16. 待拍板开放项（以下均为**建议值**，不是已决策；拍板前不得按既定值写死）

| # | 开放项 | 助手建议 | 影响面 |
| --- | --- | --- | --- |
| 1 | 配额数值：会话分析次数、IP 建会话/分析/match 窗口 | 3 次/会话；5 建会话/h/IP；10 分析/h/IP；match 60/h/IP 仅兜底、**不设会话硬配额** | demo-config 默认值、§14 测试断言、上线后按真实 GitHub 消耗日志调整 |
| 2 | 是否允许自选真实用户名（还是只给预置快照） | **允许**（这是"进入真实产品"的核心感知；预置负责秒进、自选负责真实感）；若想零实时 token 成本则只留预置 | §7.3 是否保留完整链路、§9.3 自动建会话逻辑 |
| 3 | 会话 TTL | 7 天（足够回访、短于滥用窗口）；cleanup 保留期 24h | Cookie Max-Age、demo_sessions.expires_at |
| 4 | 部署形态：同域反代（A）还是跨子域（B） | **A 同域反代**（Cookie 最简、不碰 CORS 凭证问题）；现状 API `origin:'*'` 与凭证 Cookie 不兼容，必须在上线前拍板 | §7.6 Cookie Domain、CORS_ALLOW_ORIGINS、前端 credentials、TRUST_PROXY |
| 5 | 3 个预置示例账号具体选谁 | 从第三轮校准 26 账号中选结论稳定的 likely/mixed/suspicious 各一；suspicious 候选可能被封/改名，seed 时复跑验证、只展示 ready 项；**不在设计阶段写死** | `DEMO_PRESET_LOGINS`/代码常量、seed 清单 |

拍板方式：在本表把选定值标注为"已拍板（日期）"，再按 §15 启动实现；未拍板字段在代码中一律走 demo-config 的可配置默认，不出现隐藏假设。

---

## 17. 与缓做项 / 既有设计的关系

- **账号体系 / OAuth / 本人认领**：继续缓做（[deferred-items.md](deferred-items.md) 平台与工程线，触发条件=决策 #1/#6 拍板）。演示模式不是账号体系的第一期，不建 accounts 表、不做登录；`user` 仅为编译期预留。账号体系立项时，本设计的 Principal/配额闸可平滑收编（demo→user 升级、CSRF 升级按 §12-5 重估）。
- **双方言持久化**：完全遵循 [design-storage-dual-dialect-20260911.md](design-storage-dual-dialect-20260911.md)——方言差异只在 storage 内部，API/Worker 只依赖 `IDemoSessionsRepository` 与 `createStorage()`。
- **画像缓存语义**：复用 POST /analyze 既有 `PROFILE_CACHE_TTL_MS` 缓存分支并把顺序提到权限之前，不新增缓存机制。
- **i18n / 设计 token**：遵循 [design-i18n-20260910.md](design-i18n-20260910.md)（先中文 key 再同构英文 key、守护测试）与 [design-tokens-20260910.md](design-tokens-20260910.md)（共享 `packages/ui-tokens`，禁硬编码颜色尺寸）。
- **waitlist 转化**：配额用尽引导复用既有 waitlist 留资链路与 `IWaitlistRepository`，本设计不新增留资表。
- **不引 Redis/MQ**：IP 窗口落 SQLite/Postgres 表，符合 AGENTS「MVP 不引入 Redis」与现有 Worker 无 MQ 的架构；若未来 demo 流量上来导致窗口表写入热点，再按 deferred 流程评估。
