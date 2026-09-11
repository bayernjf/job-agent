# JobAgent HTTP API 参考（M1）

- 状态：现行（M1）
- 服务：`apps/api`（Hono），默认 `http://localhost:3000`
- 内容类型：请求/响应均为 `application/json`（健康检查除外）
- CORS：MVP 阶段 `*` 开放，生产环境收紧为落地页域名
- 最后更新：2026-09-11

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
