# 设计：P2 职位聚合采集管道（Job Ingestion Pipeline）

- **状态**：现行（工程设计，可直接据此落代码）
- **日期**：2026-09-13
- **阶段**：P2 职位聚合 · 建库阶段
- **上游依据**：[设计-职位聚合-Spike-20260913.md](设计-职位聚合-Spike-20260913.md)（数据源实测、推荐组合、最小链路，本设计直接采用其结论，不再重新调研数据源）
- **关联**：[技术选型-MVP-20260910.md](技术选型-MVP-20260910.md) §6 运行架构 / 数据访问抽象层；[design-storage-dual-dialect-20260911.md](design-storage-dual-dialect-20260911.md) 双方言持久化；[../AGENTS.md](../AGENTS.md) 硬约束
- **契约事实源**：`packages/shared/src/index.ts` 的 `JobPostingSchema` / `JobSourceSchema`（已落地，本设计不改其字段）

---

## 1. 目标与范围

### 1.1 要解决的问题

把分散在各公开招聘源的技术岗位，按统一契约定时抓取、清洗、去重、入库，形成 JobAgent **自有的岗位库**。它是后续「能力画像 ↔ 岗位匹配 / 智能推荐投递」的前置基础设施（决策 #16）。

### 1.2 MVP（P2-A～P2-C）做什么

1. 新增一个纯采集包 `packages/job-source`：各数据源**适配器**（拉取 → 解析 → 映射为 `JobPosting`）+ 一个**采集编排器**（多源汇总、单源失败隔离、Zod 校验、去重 upsert）。
2. 在持久化层新增 `job_postings` 表（**sqlite/postgres 双方言各一份迁移**）与 `IJobPostingsRepository` 仓储（统一 async，业务不感知方言）。
3. 在 `apps/cli` 新增 `jobs sync` 子命令，由**系统 cron / 计划任务每日触发**（MVP 不新增常驻进程、不引入 MQ/Redis）。
4. 适配器覆盖 Spike 验证可用的源，分阶段：RemoteOK + Remotive（P2-A）→ Greenhouse + Lever（P2-B）→ HN Who's Hiring（P2-C）。

### 1.3 明确不做（MVP 边界）

- **不做全自动后台投递 / 自动申请**（决策 #15：只做用户主动触发的 Chrome 扩展一键填充，与本管道解耦）。
- 不接 Wellfound（Cloudflare turnstile）、YC Jobs（官方 API 406 + HTML 反爬）、Boss 直聘等国内源（决策 #16 口径，P2 先聚焦海外技术岗）。
- 不做跨源同岗自动合并（只算归一化碰撞键做统计/提醒，见 §6.3）。
- 不上全文搜索引擎（万级行用 SQL `LIKE` + 结构化过滤即可，见 §7.4）。
- 不存原始响应全量（只存剥离 HTML 后的精简快照 + 源链接，对齐画像「精简快照」原则）。
- 不做岗位对用户的搜索 API / 页面（P2-D 才做，本设计只在仓储层预留查询能力）。

---

## 2. 整体架构与数据流

### 2.1 分层（对齐现有「内核与 I/O 分离」「数据访问收敛」硬约束）

```text
系统 cron / 计划任务（每日）
        │  调用
        ▼
apps/cli  `jobs sync [--source=...]`        ← 唯一触发入口（MVP）
        │
        ▼
packages/job-source（纯采集 + 编排，无 DB 驱动、无定时器）
  ├─ httpClient：超时 / 重试 / UA / 可选代理（fetch 可注入）
  ├─ adapters/：每个源一个适配器（fetch 原始数据 + parse 纯函数 → JobPosting[]）
  ├─ normalize/：HTML 剥离、薪资年化 USD、remote 推断、文本截断、归一化键
  └─ ingestor：syncOnce() 编排多源，单源失败隔离，产出 SyncResult
        │  JobPosting[]（已过 Zod）
        ▼
packages/storage · IJobPostingsRepository.upsertBatch()   ← 唯一 DB 入口
        │
        ▼
job_postings 表（sqlite / postgres，迁移 005 双方言对齐）
```

**职责边界（硬约束，与 github-source / analyzer-core 一致）**：

- `packages/job-source` **不直接 new 数据库驱动、不写裸 SQL、不内置定时器**；它只负责「拿到原始数据 → 产出合法 `JobPosting[]`」。写库通过注入的仓储接口完成，便于对录制夹具做确定性单测。
- 方言差异只允许出现在 `packages/storage` 内部；`job-source` 与 `cli` 只依赖 `IJobPostingsRepository` 接口。
- 网络请求的 `fetch` 必须可注入（测试传 fake fetch，默认 Node 全局 fetch），**测试不打真实源**（对齐「默认确定性」）。

### 2.2 一次同步的时序

1. CLI 解析参数（启用哪些源、是否 dry-run），`createStorage()` 拿到仓储，构造 `httpClient` 与各适配器。
2. `ingestor.syncOnce({ adapters, repo, now })`：对每个适配器
   - `raw = adapter.fetch(httpClient)`（网络 I/O，限频/重试在 httpClient 内）；
   - `postings = adapter.parse(raw, { fetchedAt: now })`（**纯函数**，映射 + 归一化）；
   - 逐条 `JobPostingSchema.safeParse`，非法项收集进 `failed`，**不中断整源**；
   - 调 `repo.upsertBatch(validPostings)`，返回 `{ inserted, updated }` 计数。
3. 单个适配器抛错（网络 5xx 连续失败、解析异常）被 ingestor 捕获，记入该源 `error`，**继续下一个源**（单源失败隔离）。
4. 汇总 `SyncResult`，CLI 打印结构化摘要（每源 fetched/inserted/updated/failed + 错误），非零退出码仅在「全部源失败」时返回（cron 失败可感知）。

---

## 3. 命名约定（重要：规避现有 `jobs` 冲突）

现有持久化层已有 `analysis_jobs` 表，且 `StorageContext.jobs: IAnalysisJobsRepository`（分析任务队列）已占用 `jobs` 这一属性名。为避免语义混淆：

| 概念 | 物理表名 | TS 仓储属性 / 接口 | 领域实体 |
| --- | --- | --- | --- |
| 分析任务（已有） | `analysis_jobs` | `StorageContext.jobs` / `IAnalysisJobsRepository` | `StoredAnalysisJob` |
| **职位（本设计新增）** | **`job_postings`** | **`StorageContext.jobPostings` / `IJobPostingsRepository`** | `StoredJobPosting` / `NewJobPosting` |

- 采集包命名 `packages/job-source`（与 `github-source` 对称：一个 source 包负责一类外部源）。
- 适配器产出的对象严格是 shared 的 `JobPosting`；存储层实体 `NewJobPosting` 在其基础上补充内部字段（`id`、`status`、`normalizedKey`、时间戳）。

---

## 4. 数据模型：`job_postings` 表（迁移 005，双方言）

### 4.1 字段设计

DB 字段 `snake_case`；与 `JobPosting`（camelCase）的转换集中在 storage 实体映射层。

| 列 | 类型 | 约束 / 默认 | 说明 |
| --- | --- | --- | --- |
| `id` | TEXT | PRIMARY KEY | 内部稳定 id = `sha1(source + '\u0000' + source_url)` 前 16 位（同源同 URL 幂等） |
| `source` | TEXT | NOT NULL | `JobSource` 枚举值之一 |
| `source_url` | TEXT | NOT NULL | 岗位回源 URL，**同源去重唯一键的一部分** |
| `title` | TEXT | NOT NULL | 职位标题 |
| `company` | TEXT | NOT NULL | 公司名（源内原始名，不做跨源公司归一） |
| `location` | TEXT | | 可空（纯远程岗位可能为空） |
| `remote` | INTEGER(bool) / BOOLEAN | NOT NULL DEFAULT 0 | 是否远程 |
| `salary_min` | INTEGER | | 年化下限（**统一为 USD/年**，无则 NULL） |
| `salary_max` | INTEGER | | 年化上限（USD/年） |
| `salary_currency` | TEXT | | 原始币种代码（如 USD/EUR，用于审计） |
| `tags` | TEXT | NOT NULL DEFAULT '[]' | JSON 字符串数组 |
| `description` | TEXT | | 剥离 HTML 后的精简纯文本，**截断 ≤ 8000 字符**（常量可配） |
| `posted_at` | TEXT | NOT NULL | 源站发布时间（UTC ISO8601；缺失退化为 fetched_at 并打标，见 §6.4） |
| `apply_url` | TEXT | | 申请链接（可空，缺省回退 source_url） |
| `company_logo_url` | TEXT | | 公司 logo |
| `company_url` | TEXT | | 公司主页 |
| `normalized_key` | TEXT | | 跨源碰撞键：归一化(title+company+location) 的 sha1，见 §6.3 |
| `status` | TEXT | NOT NULL DEFAULT 'active' | `active` / `inactive`（连续 N 天未再被抓到 → 下线，见 §6.5） |
| `first_seen_at` | TEXT | NOT NULL | 本库首次抓到时间（upsert 时不覆盖） |
| `last_seen_at` | TEXT | NOT NULL | 最近一次仍在源站出现的时间（每次 upsert 刷新） |
| `fetched_at` | TEXT | NOT NULL | 本条内容最近一次抓取时间（内容刷新时间） |
| `created_at` | TEXT | NOT NULL DEFAULT CURRENT_TIMESTAMP | 行创建时间 |
| `updated_at` | TEXT | NOT NULL DEFAULT CURRENT_TIMESTAMP | 行最近更新时间 |

**唯一约束**：`UNIQUE(source, source_url)` —— 同源去重/幂等 upsert 的依据。

**索引**：

- `idx_job_postings_status_posted` ON `(status, posted_at DESC)`：默认列表「在招 + 最新」。
- `idx_job_postings_source` ON `(source)`：按源统计 / 单源重抓。
- `idx_job_postings_company` ON `(company)`：按公司过滤。
- `idx_job_postings_normalized` ON `(normalized_key)`：跨源碰撞排查（P2-D 合并用）。
- 唯一索引 `idx_job_postings_source_url` ON `(source, source_url)`（或直接表级 UNIQUE 约束）。

> 薪资用 INTEGER 存「年化美元整数」，避免浮点；原始币种保留在 `salary_currency` 以便回溯换算。月薪/时薪→年化的换算规则见 §6.2，**换算不确定就存 NULL，不猜**。

### 4.2 迁移文件（两侧编号文件名必须一一对应）

- `db/migrations/sqlite/005_create_job_postings.sql`
- `db/migrations/postgres/005_create_job_postings.sql`

严格遵循 [../MIGRATION_CONVENTION.md](../MIGRATION_CONVENTION.md)：标准文件头（Migration/File/Date/Dialect/Ref/Note）、`IF NOT EXISTS` 幂等、PG 侧每个列与表补 `COMMENT ON`、末尾 `-- DOWN BEGIN / DROP TABLE ... / -- DOWN END`。两文件除方言差异（SQLite `INTEGER` 布尔 / `CURRENT_TIMESTAMP` 无括号 vs PG `BOOLEAN` / `CURRENT_TIMESTAMP`）外结构一致。`bash tools/check-migrations.sh` 必须通过；`schema-parity` / `migrations-parity` 一致性测试要补 005 用例。

### 4.3 Drizzle schema 与实体（storage 内部）

- `packages/storage/src/sqlite/schema.ts` 新增 `jobPostings`（`sqliteTable`，布尔用 `integer({mode:'boolean'})`，数组/快照用 `text`）。
- `packages/storage/src/postgres/schema.ts` 对称新增（`pgTable`，`boolean`/`jsonb`/`text`/`integer` 对齐；`tags` PG 侧可用 `jsonb().$type<string[]>()`，但为保证两侧读写形态一致，MVP **两侧都用 TEXT 存 JSON 字符串**，在实体映射层 `JSON.parse/stringify`，降低双方言漂移风险）。
- 新增 `packages/storage/src/entities/job-posting.ts`：`StoredJobPosting` / `NewJobPosting` / `RawJobPostingRow` + `toStoredJobPosting(row)` 纯映射（tags 解析、snake↔camel），双方言共享，写法对齐 `entities/waitlist.ts`。

---

## 5. 仓储契约 `IJobPostingsRepository`

接口文件：`packages/storage/src/repositories/job-postings.ts`，**全部 async**（对齐现有仓储，sqlite 同步驱动也包成 async）。

```ts
export interface JobPostingQuery {
  /** 自由文本：在 title/company/tags 上做大小写不敏感 LIKE（AND 分词，MVP） */
  keyword?: string;
  sources?: JobSource[];          // 白名单过滤
  remote?: boolean;
  company?: string;               // 精确（归一化后）匹配
  tags?: string[];                // 命中任一即可（OR）
  status?: 'active' | 'inactive'; // 默认 active
  salaryMinUsd?: number;          // salary_max >= 该值（过滤掉低于下限的岗）
  postedAfter?: string;           // ISO 时间，posted_at >=
  limit?: number;                 // 默认 100，上限 500
  offset?: number;
  orderBy?: 'posted_desc' | 'posted_asc' | 'salary_desc'; // 默认 posted_desc
}

export interface UpsertCounts { inserted: number; updated: number; unchanged: number; }

export interface IJobPostingsRepository {
  /**
   * 幂等批量 upsert：按 UNIQUE(source, source_url)。
   * - 不存在：插入，first_seen_at=last_seen_at=fetched_at=now
   * - 已存在：刷新可变内容与 last_seen_at/fetched_at，保留 first_seen_at、id
   * - 内容哈希无变化：只刷 last_seen_at，计 unchanged（减少写放大，可选优化）
   * 单事务批量提交；返回三类计数。
   */
  upsertBatch(postings: NewJobPosting[], now: string): Promise<UpsertCounts>;

  /** 条件查询（P2-A 先实现，供 CLI jobs search / 后续 API 复用） */
  search(query: JobPostingQuery): Promise<StoredJobPosting[]>;
  countBySource(status?: 'active' | 'inactive'): Promise<Record<string, number>>;

  /** 下线维护：last_seen_at < cutoff 的 active 岗位置 inactive，返回受影响行数 */
  markStale(cutoffIso: string): Promise<number>;

  getById(id: string): Promise<StoredJobPosting | undefined>;
}
```

**实现要点**：

- SQLite：`insert ... onConflictDoUpdate({ target: [source, sourceUrl], set: {...} })`（drizzle），批量包在 `db.transaction` 内；`LIKE` 用 `%kw%`，多关键词 AND 拼接，参数化（**禁止字符串拼接用户输入**）。
- Postgres：`onConflictDoUpdate` 同源写法；`ILIKE` 替代 `LIKE`（大小写不敏感）——该差异封装在两套 repo 实现内，接口不暴露。
- 两套实现：`sqlite/job-postings-repo.ts`、`postgres/job-postings-repo.ts`，并在 `storage.ts` 的**两个分支各 new 一个**、`types.ts` 的 `StorageContext` 加 `jobPostings`、`repositories/index.ts` 与 `src/index.ts` 同步导出（共 5 处装配点，与新增 waitlist 时一致）。

---

## 6. `packages/job-source` 详细设计

### 6.1 目录结构

```text
packages/job-source/
├─ package.json            # name @jobagent/job-source；依赖 @jobagent/shared
├─ tsconfig.json
├─ src/
│  ├─ index.ts             # 对外导出（对齐 github-source/src/index.ts）
│  ├─ types.ts             # Adapter/SyncResult/SyncOptions 等类型
│  ├─ http-client.ts       # 带超时/重试/UA/可选代理的 JSON GET（fetch 可注入）
│  ├─ ingestor.ts          # syncOnce 编排（纯逻辑，依赖注入，可单测）
│  ├─ ingestor.test.ts
│  ├─ adapters/
│  │  ├─ types.ts          # JobSourceAdapter 接口
│  │  ├─ remoteok.ts (+.test.ts)
│  │  ├─ remotive.ts (+.test.ts)
│  │  ├─ greenhouse.ts (+.test.ts)
│  │  ├─ lever.ts (+.test.ts)
│  │  ├─ hn-whoishiring.ts (+.test.ts)
│  │  └─ registry.ts       # source -> adapter 工厂；启用清单
│  └─ normalize/
│     ├─ html.ts           # stripHtml / collapseWhitespace / truncate
│     ├─ salary.ts         # 薪资年化 USD
│     ├─ remote.ts         # remote 推断
│     ├─ dedupe-key.ts     # 跨源 normalized_key
│     └─ *.test.ts
└─（夹具放仓库根 tests/fixtures/jobs/，见 §10）
```

### 6.2 统一适配器接口与共享归一化

```ts
// adapters/types.ts
export interface RawFetchContext {
  fetchedAt: string;        // ISO，由 ingestor 统一传入，保证一批时间一致
  http: JobHttpClient;      // 注入的 httpClient
}
export interface JobSourceAdapter {
  readonly source: JobSource;
  /** 拉取 + 解析一体；parse 拆出为可独立测试的导出纯函数 */
  collect(ctx: RawFetchContext): Promise<JobPosting[]>;
}
```

共享归一化函数（`normalize/`，全部纯函数、各自带单测）：

- **`stripHtml(html, maxLen)`**：去标签/解码常见实体/折叠空白/截断到 8000 字符。MVP 用轻量正则 + 实体映射，**不引第三方 HTML 解析库**（岗位正文无需高保真，避免新依赖）。
- **`toAnnualUsd(...)`**：把源里的薪资表达换算为 `{min,max,currency}` 年化整数。规则：
  - 已知是年薪直接取；时薪 × 典型年工时（2080）、月薪 × 12；区间保留 min/max；
  - 非 USD 且无实时汇率表时：保留 `salary_currency`，`salary_min/max` 置 NULL（**不硬编码猜测汇率**；汇率换算列入开放项）；
  - 字段缺失/无法解析 → 三者 NULL。
- **`inferRemote(text, location)`**：标题/位置/tags 命中 `remote|远程|anywhere|worldwide` 等 → `remote=true`；源有显式 remote 标志位时优先用标志位。
- **`truncate` / `nonNull` / `parseDate`**：日期统一转 UTC ISO；无法解析的 postedAt 处理见 §6.4。

### 6.3 同源与跨源去重

- **同源（强去重，落库幂等）**：`UNIQUE(source, source_url)` + upsert。适配器负责为每条岗位产出**规范、稳定**的 `sourceUrl`（去除跟踪参数 `utm_*`、ref 等，排序 query），避免同一岗位因 URL 参数不同被重复收录。
- **跨源（只标记，不合并）**：`normalized_key = sha1(norm(title) + '|' + norm(company) + '|' + norm(location))`，其中 `norm` = 小写、去标点、去空白、去常见公司后缀（Inc/Ltd/LLC）。同 key 不同 source 即「疑似同岗多源」，MVP 仅落库供统计/人工排查，**不自动合并行**（自动合并是 P2-D 开放决策，见 §13）。

### 6.4 时间字段策略

- `postedAt`：优先源字段（RemoteOK `date`/`last_updated`、Remotive `publication_date`、Greenhouse `first_published`/`updated_at`、Lever `createdAt`）。
- 源确实缺发布时间时：`postedAt = fetchedAt`，并在 `tags` 追加内部标记 `'date:unknown'`（可在展示侧过滤），保证 `posted_at NOT NULL` 且不伪造真实日期。
- `fetchedAt` 由 ingestor 对整批取同一个 `now`；`first/last_seen_at` 由仓储层维护。

### 6.5 岗位下线（staleness）

源 API 通常只返回当前在招岗位，不返回「已关闭」事件。策略：每次 sync upsert 刷新 `last_seen_at`；sync 成功后 CLI 调 `repo.markStale(now - STALE_DAYS)`（默认 **STALE_DAYS=7**，主源日更则连续 7 天没再出现视为下线）置 `inactive`。**不物理删除**，保留历史用于匹配回溯。`inactive` 默认不进搜索结果。

### 6.6 各源适配器映射要点（字段以 Spike §2/§7 实测为准）

> 下列只列**关键、易错点**；完整字段以 `tests/fixtures/jobs/` 录制样本为准，落代码时对照 Spike 文档，不凭记忆。

**RemoteOK**（P2-A）

- 单 GET `https://remoteok.com/api`，返回 JSON **数组，第 0 项是 meta（legal 声明等），岗位从下标 1 开始**——必须 `slice(1)`。
- 字段：`position`→title、`company`、`location`、`url`→sourceUrl/applyUrl、`tags`(数组)、`salary_min/salary_max`（已是年薪 USD）、`description`(HTML→strip)、`date`(epoch 秒→ISO)、`company_logo`、logo 与公司链接。
- **合规**：RemoteOK ToS 要求对外展示保留回源链接——`sourceUrl` 必须保留、不可只存正文。

**Remotive**（P2-A）

- 单 GET `https://remotive.com/api/remote-jobs`，返回 `{ jobs: [...] }`。
- `title`、`company_name`→company、`candidate_required_location`→location、`url`、`tags`、`salary_min/max`（可能为字符串，需解析；币种 `salary_currency`）、`description`(HTML)、`publication_date`、`company_logo`、`job_type`。

**Greenhouse boards**（P2-B）

- 需维护 **board token 清单**（示例 `airtable`）：`https://boards-api.greenhouse.io/v1/boards/{token}/jobs?content=true`（`content=true` 才带正文 HTML）。
- `{ jobs: [...] }`：`title`、`location.name`、`absolute_url`→sourceUrl、`content`(HTML)、`first_published`/`updated_at`、`metadata`（薪资多在 metadata，缺则 NULL）；公司名来自 board token 对应的公司名（清单里带 `{token, company}` 映射，因为岗位 JSON 不含公司名）。
- 清单来源见 §13 开放项；MVP 用一份代码内常量 / `config/greenhouse-boards.json` 种子清单（10～30 个目标公司），逐 token 请求，token 间串行 + 小间隔（≥300ms）。

**Lever postings**（P2-B）

- 维护 **公司 slug 清单**（示例 `alluxio`）：`https://api.lever.co/v0/postings/{slug}?mode=json`，返回数组。
- `text`→title、`categories.location`/`categories.team`/`categories.commitment`、`hostedUrl`→sourceUrl、`descriptionPlain`（**优先纯文本**，没有再 strip `description` HTML）、`createdAt`(epoch 毫秒)、`lists`/`workplaceType`（remote 判断）；公司名来自 slug 清单映射。

**HN Who's Hiring**（P2-C，自由文本，复杂度最高，放最后）

- 走 Algolia API：先查月度 "Ask HN: Who is hiring? (Month YYYY)" 父帖，再拉其顶层评论；每条评论是一段自由文本，需解析「公司 | 岗位 | 地点 | 远程 | 薪资 | 描述 | 链接」。
- MVP 用**保守规则解析器**（分隔符 `|` 切分 + 正则），解析置信度不足的整条跳过并计数（不污染库）；`sourceUrl` 用评论 permalink。该适配器单独阶段，不阻塞 A/B。

### 6.7 HTTP 客户端 `http-client.ts`

- 单一职责：`getJson(url, {timeoutMs, retries, headers})`，默认 `timeoutMs=15000`、`retries=2`（仅对网络错误/5xx/429 重试，4xx 不重试，对齐 github-client 的 doNotRetry 思路）、429 读 `Retry-After`。
- 固定 `User-Agent: job-agent/0.1 (+https://github.com/bayernjf/job-agent)`（公开 API 基本要求，可辨识）。
- 支持 `JOB_HTTP_PROXY`（undici ProxyAgent / 或环境 `HTTPS_PROXY`）：Spike 实测本机直连部分源不稳、经 `127.0.0.1:7897` 代理可达——代理只通过环境变量注入，**不写死在代码里、不入 Git**。
- `fetch` 构造时可注入（测试 fake）；不引入新 HTTP 库（Node 全局 fetch + undici 即可，除非代理支持确需 undici，届时在该包内隔离）。

### 6.8 编排器 `ingestor.syncOnce`

```ts
export interface SourceSyncOutcome {
  source: JobSource;
  fetched: number;      // parse 出的条数
  inserted: number;
  updated: number;
  unchanged?: number;
  invalid: number;      // Zod 校验失败条数
  error?: string;       // 单源失败信息（存在即该源失败，但不影响其他源）
  durationMs: number;
}
export interface SyncResult { outcomes: SourceSyncOutcome[]; ok: boolean; startedAt: string; finishedAt: string; }

export async function syncOnce(deps: {
  adapters: JobSourceAdapter[];
  repo: Pick<IJobPostingsRepository, 'upsertBatch' | 'markStale'>;
  now?: () => string;          // 注入时间
  staleDays?: number;
  logger?: Pick<Console,'info'|'warn'|'error'>;
}): Promise<SyncResult>;
```

要点：源之间**串行**（公开 API 礼貌抓取、避免并发冲击；单源内 Greenhouse/Lever 的多 board 也串行限速）；每源 try/catch 隔离；合法项批量 upsert；全部源结束后统一 `markStale`；`ok = 至少一个源无 error 且有产出`。

---

## 7. CLI 触发（MVP 唯一入口，不新增常驻进程）

### 7.1 为什么用 CLI + 系统 cron，而不是新建常驻 app / 塞进现有 worker

- 现有 `apps/worker` 是「轮询 `claimNext` 消费 `analysis_jobs`」的**事件驱动队列消费者**，与「定时全量同步公开岗位」的**批处理**模式不同；混在一个主循环会让两类失败/重试/限频耦合。
- 岗位同步是**一天一次的低频批处理**，没必要为它常驻一个进程（也符合 MVP 不引入 MQ/Redis 的约束）。
- 因此把可测的编排逻辑全部放在 `packages/job-source`，`apps/cli` 只做**薄触发层**；未来若需要常驻调度或多实例，再新增 `apps/job-ingestor` 复用同一 `syncOnce`（演进路径见 §11），编排逻辑零重写。

### 7.2 CLI 子命令（对齐 apps/cli 现有命令风格）

```text
pnpm --filter @jobagent/cli start jobs sync [--source=remoteok,remotive] [--dry-run] [--stale-days=7]
pnpm --filter @jobagent/cli start jobs search --keyword=rust --remote --limit=20
pnpm --filter @jobagent/cli start jobs stats
```

- `sync`：构造启用的适配器 → `syncOnce` → 打印每源表格摘要；`--dry-run` 只解析/校验、打印条数不写库（用于上线前验证）。
- `search`：走 `repo.search`，输出 NDJSON / 表格（供人工核对，先不做 UI）。
- `stats`：`countBySource`，快速看库规模。
- 退出码：全源失败 → 1；部分源失败 → 0 但 stderr 告警；全成功 → 0。

### 7.3 调度

- 本地/单机：系统计划任务每日跑一次（Windows 任务计划程序 / Linux cron / 后期服务端 systemd timer），命令写入文档，不进代码。
  - 例（Linux）：`17 3 * * * cd /srv/job-agent && pnpm --filter @jobagent/cli start jobs sync >> logs/jobs-sync.log 2>&1`（错峰整点）。
- 频率（Spike 结论）：RemoteOK/Remotive/Greenhouse/Lever **日更**；HN 月度帖**每月跑一次**即可（CLI 单独 `--source=hn_whoishiring`，cron 月度触发）。

### 7.4 为什么暂不建搜索 API / 页面

P2 的目标是**先把库建起来、尽早积累数据**（岗位有时效，越早开始日更，历史越厚）。`GET /jobs` 搜索 API 与画像匹配属于「消费侧」，依赖岗位库有一定存量后再做价值更大，故列 P2-D。仓储层 `search()` 已在 P2-A 落地，届时 API 只是薄封装，不返工。

---

## 8. 配置与环境变量（同步写入 `.env.example`）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `JOB_SYNC_SOURCES` | `remoteok,remotive`（P2-A） | 启用源，逗号分隔；P2-B 后加 greenhouse,lever |
| `JOB_HTTP_TIMEOUT_MS` | `15000` | 单请求超时 |
| `JOB_HTTP_RETRIES` | `2` | 网络错误/5xx/429 重试次数 |
| `JOB_STALE_DAYS` | `7` | 连续多少天未再出现置 inactive |
| `JOB_HTTP_PROXY` | 空 | 可选出站代理（如 `http://127.0.0.1:7897`），仅本地用，不入库不入 Git |
| `DB_DRIVER` / `DB_PATH` / `DATABASE_URL` | 沿用 | 复用现有持久化配置 |

Greenhouse board / Lever slug 清单：MVP 放 `packages/job-source/src/adapters/boards.seed.ts`（或 `config/*.json`，随代码版本化），**不依赖任何私密凭证**（这些都是公开 board API）。

---

## 9. 合规与外部约束

- 只抓**公开、无需登录**的 API/Feed；设置可辨识 UA、限速、不过度并发；遵守各源 ToS。
- **RemoteOK**：对外展示必须保留回源链接（`source_url`），本设计强制保留且不删。
- **不碰**带反爬/需登录/明确禁止抓取的源（Wellfound turnstile、YC 反爬），不为绕过反爬做任何尝试。
- 只存精简文本快照（截断），不缓存可再分发的原始大负载；岗位版权归原站，产品侧展示走「摘要 + 回源链接」。
- 采集侧不需要任何用户私密 token（区别于 GitHub 采集需要 GITHUB_TOKEN）；代理等本地配置不进 Git。

---

## 10. 测试策略（默认确定性，不打真实源）

对齐 AGENTS.md「测试与验证」：测试就近 `*.test.ts`（Vitest），外部响应一律用**录制并脱敏的夹具**，网络用 fake fetch。

1. **夹具**：`tests/fixtures/jobs/{remoteok,remotive,greenhouse,lever,hn}.sample.json`，每个源录制 1 份真实响应（小样本、脱敏无关个人信息），作为 parse 黄金样本。
2. **适配器 parse 单测**（每个源）：给定夹具 → 产出合法 `JobPosting[]`；覆盖易错点：
   - RemoteOK `slice(1)` 跳过 meta；
   - 缺薪资 / 字符串薪资 / 非美元；
   - HTML 正文被正确剥离与截断；
   - remote 推断；日期缺失回退 + `date:unknown` 标记；sourceUrl 去跟踪参数。
3. **normalize 单测**：时薪/月薪→年化、远程关键词、归一化键稳定性、HTML 截断边界。
4. **http-client 单测**：注入可控 fake fetch（延迟/5xx/429/4xx），验证超时、重试次数、4xx 不重试、Retry-After。
5. **ingestor 单测**：fake adapter + 内存仓储，验证多源串行、单源抛错不影响其他源、Zod 非法项计入 invalid 不中断、markStale 被调用、`ok` 语义。
6. **仓储测试**：
   - sqlite：内存库测 `upsertBatch` 的插入/更新/幂等（同 source+url 两次不产生重复行、first_seen 保留、last_seen 刷新）、`search` 各过滤条件与分页、`markStale`；
   - postgres：`postgres-behavior.test.ts` 同款「仅当 `DATABASE_TEST_URL` 存在才实跑，否则 skip」；重点验证 `onConflictDoUpdate` 与 `ILIKE`。
7. **双方言一致性**：为 005 补 `schema-parity` / `migrations-parity` 用例；`bash tools/check-migrations.sh` 必须过。
8. **门禁**：交付前 `pnpm -r typecheck` + `pnpm -r test` + `pnpm -r build` + `bash tools/check-migrations.sh` + `git diff --check`。

---

## 11. 演进路径（不在 MVP 实现，先记方向）

- **常驻调度**：当单日同步时长变大或需要多频次时，新增薄 app `apps/job-ingestor` 复用 `syncOnce`（内置定时器/优雅关闭，写法对齐 apps/worker），CLI 保留用于手动补数。
- **增量同步**：利用 `If-Modified-Since`/ETag 与源的 `updated_at` 做条件请求，减少传输（RemoteOK/Remotive 当前为全量小负载，日更可接受，先不做）。
- **跨源合并**：基于 `normalized_key` 做「主记录 + 多源指针」的合并模型（需新增关联表与合并策略，属 P2-D 决策）。
- **搜索升级**：数据量到十万级 / 需要相关性排序时，再评估 SQLite FTS5 / Postgres tsvector，接口 `search()` 签名保持稳定、只换实现。
- **画像 ↔ 岗位匹配**：消费侧能力，依赖 analyzer-core 的 skillTags 与岗位 tags/正文做匹配，单独立项。

---

## 12. 分阶段落地序列（每阶段可独立验收、独立原子提交）

### P2-A：最小闭环（RemoteOK + Remotive）——优先

1. storage：迁移 005（双侧）+ 双方言 schema + entities + `IJobPostingsRepository` + 两套实现 + 5 处装配导出。
2. `packages/job-source` 骨架：http-client、normalize（html/salary/remote/dedupe-key）、ingestor、types。
3. remoteok / remotive 两适配器 + 夹具 + 全部单测。
4. apps/cli：`jobs sync/search/stats` 子命令。
5. `.env.example` 补变量；`--dry-run` 跑通后真实 `sync` 一次，验证入库与去重（第二次跑 inserted≈0、updated/unchanged 为主）。
- **验收**：三件套 + 迁移校验全绿；连续两次 sync 不产生重复行；search 能按 keyword/remote 过滤。

### P2-B：Greenhouse + Lever（board 清单模式）

6. greenhouse / lever 适配器 + board/slug 种子清单 + 串行限速 + 夹具单测；默认启用源清单追加这两个。

### P2-C：HN Who's Hiring（自由文本）

7. Algolia 拉取 + 保守解析器 + 置信度门槛 + 单测；cron 月度触发，不与日更源混跑。

### P2-D（另立项）：消费侧

8. `GET /jobs` 搜索 API（Hono，薄封装 repo.search）→ 岗位与画像匹配 → 报告页/扩展消费。

> 每个子步骤按「功能 / 测试 / 文档」原子提交拆分，英文 Conventional Commit（scope 用 `jobs` / `db` / `cli`），不加 AI co-author，不主动 push（遵循用户偏好）。

---

## 13. 开放项（落代码前/中需拍板，先给推荐，不臆断）

| # | 开放项 | 本设计推荐（MVP） | 待确认点 |
| --- | --- | --- | --- |
| O1 | 调度形态 | CLI `jobs sync` + 系统 cron，不新增常驻进程 | 是否认可「先 CLI、后按需抽 app」 |
| O2 | 跨源同岗是否合并 | 只算 `normalized_key` 标记，不自动合并（P2-D 再定合并模型） | 是否需要 MVP 就合并 |
| O3 | Greenhouse/Lever 清单来源 | 代码内种子清单（10–30 家目标公司）版本化维护 | 目标公司名单谁来定、多久更新；是否做公开 board 目录自动发现（缓做） |
| O4 | 非美元薪资换算 | 保留原始币种、年化值置 NULL，不猜汇率 | 是否引入一份静态汇率表（会带来更新成本） |
| O5 | 岗位下线阈值 | `STALE_DAYS=7`（主源日更） | HN 月度源是否用更宽阈值（建议 35 天） |
| O6 | description 上限 | 8000 字符截断 | 是否影响后续匹配质量（匹配主要靠 tags/标题，影响可控） |
| O7 | 首轮是否连搜索 API/UI | 不连，P2-A 只入库 + CLI search | 消费侧排期（P2-D） |
| O8 | 新包命名 | `@jobagent/job-source`，表 `job_postings`、仓储 `jobPostings`（规避现有 jobs 冲突） | 是否认可该命名 |

---

## 14. 落代码文件清单（Checklist）

**新增**

- [ ] `db/migrations/sqlite/005_create_job_postings.sql`
- [ ] `db/migrations/postgres/005_create_job_postings.sql`
- [ ] `packages/storage/src/entities/job-posting.ts`
- [ ] `packages/storage/src/repositories/job-postings.ts`
- [ ] `packages/storage/src/sqlite/job-postings-repo.ts`
- [ ] `packages/storage/src/postgres/job-postings-repo.ts`
- [ ] `packages/job-source/`（package.json/tsconfig + src 全套，见 §6.1）
- [ ] `tests/fixtures/jobs/*.sample.json`
- [ ] apps/cli 内 `jobs` 命令组（sync/search/stats）

**修改（装配点，缺一不可）**

- [ ] `packages/storage/src/sqlite/schema.ts` + `postgres/schema.ts`：加 `jobPostings` 表定义
- [ ] `packages/storage/src/repositories/index.ts` + `src/index.ts`：导出新接口/实体
- [ ] `packages/storage/src/types.ts`：`StorageContext` 加 `jobPostings`
- [ ] `packages/storage/src/storage.ts`：sqlite/postgres 两分支各 `new XxxJobPostingsRepository(db)`
- [ ] `apps/cli` 命令注册处：挂 `jobs` 命令组
- [ ] `.env.example`：补 §8 变量
- [ ] 一致性测试补 005：`migrations.test.ts` / `schema-parity` / `migrations-parity`

**文档收尾**

- [ ] handoff.md「Project documents」登记本文；item 10（P2）标注「采集管道设计已落地，进入 P2-A 编码」
- [ ] docs/README.md 场景导航补一行
