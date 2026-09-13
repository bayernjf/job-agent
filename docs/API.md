# JobAgent HTTP API 参考（M1 + P2 职位聚合）

- 状态：现行（M1）
- 服务：`apps/api`（Hono），默认 `http://localhost:3000`
- 内容类型：请求/响应均为 `application/json`（健康检查除外）
- CORS：MVP 阶段 `*` 开放，生产环境收紧为落地页域名
- 最后更新：2026-09-13

> 本文件只描述对外 HTTP 契约。内部分析管道见 AGENTS.md「运行架构」，画像字段结构见 `packages/shared` 的 `AbilityProfileSchema`。

---

## 通用约定

### 错误响应格式

所有 4xx/5xx 返回统一结构：

```json
{ "error": "machine-readable message", "details": { } }
```

`details` 仅在 400 校验失败时出现（Zod `flatten()` 结果）。

### 状态码约定

| 码 | 含义 |
| --- | --- |
| 200 | 成功（含去重命中、缓存命中） |
| 201 | 新建分析任务成功 |
| 400 | 请求体/参数非法 |
| 404 | 任务或画像不存在 |
| 500 | 服务内部错误 |

### 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | 监听端口 |
| `DB_DRIVER` | `sqlite` | `sqlite` \| `postgres` |
| `DB_PATH` | `data/job-agent.db` | SQLite 文件路径（sqlite 时） |
| `DATABASE_URL` | — | Postgres 连接串（postgres 时） |
| `PROFILE_CACHE_TTL_MS` | `86400000`（24h） | 完整画像缓存有效期 |

---

## 1. 触发分析

### `POST /analyze`

为一个 GitHub 用户名创建异步分析任务。响应分三种情况：**缓存命中**、**任务去重命中**、**新建任务**。

#### 请求体

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `username` | string | 是 | GitHub 登录名，1–39 字符，须符合 GitHub 用户名规则 |
| `platform` | `"github"` | 否 | 默认 `github`（MVP 仅支持 github） |

```json
{ "username": "sindresorhus" }
```

#### 响应 A：新建任务（201）

无未过期完整画像、也无进行中任务时创建。

```json
{
  "jobId": "job-5f8d-...",
  "status": "queued",
  "dedup": false,
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

## 3.2 职位聚合：岗位检索与画像匹配（P2-D）

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

先用结构化条件取候选池（默认最近 500 条），再按画像技能名对 title（权重 3）/tags（权重 2）/description（权重 1）做词边界加权打分，按分数降序返回；至少命中一个技能才会出现在结果里。技能名通常取自 `GET /profiles/:id/exportable` 的 `skills[].name`。

#### 请求体

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `skills` | string[] | 是（≥1） | 技能名列表，缺失或空数组返回 400 |
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
// 响应（200）
{
  "matches": [
    { "score": 5, "matchedSkills": ["Python", "React"], "posting": { "title": "...", "source": "remoteok", "sourceUrl": "..." } }
  ],
  "total": 1
}
```

---

## 4. 健康检查

### `GET /health`

无需请求体，用于探活/负载均衡。

```json
{ "status": "ok", "service": "jobagent-api", "time": "2026-09-11T08:00:00.000Z" }
```

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
