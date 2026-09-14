# JobAgent HTTP API 参考（M1 + P2 职位聚合）

- 状态：现行（M1 + P2）
- 服务：`apps/api`（Hono），默认 `http://localhost:3000`
- 内容类型：请求/响应均为 `application/json`（健康检查除外）
- CORS：MVP 阶段 `*` 开放，生产环境收紧为落地页域名
- 最后更新：2026-09-14

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

## 3.2 查询画像岗位推荐（第一档匹配接线）

### `GET /profiles/:id/job-recommendations`

以画像快照的 `skillTags[].name` 为技能集，先取候选岗位池，再按与 [`POST /job-postings/match`](#33-职位聚合岗位检索与画像匹配p2-d) 相同的加权规则打分，返回该画像的岗位推荐。报告页「为你推荐的岗位」island 即消费此端点（同源调用）。

#### 路径参数

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 画像 id，非法格式返回 400 |

#### Query 参数（全部可选）

| 参数 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `remote` | `true` \| 其它 | — | 仅 `"true"` 视为只看远程 |
| `sources` | string | — | 逗号分隔数据源（如 `remoteok,lever`），出现非法值返回 400 |
| `salary_min` | number | — | 薪资下限（USD，非负整数），非法返回 400 |
| `limit` | number | `20` | 返回上限，1–100，越界返回 400 |
| `candidate_limit` | number | `500` | 候选池大小，1–500，越界返回 400 |

#### 响应（200）

```json
{
  "profileId": "prof-...",
  "profileSkills": ["TypeScript", "React"],
  "matches": [
    {
      "score": 9,
      "matchedSkills": ["TypeScript", "React"],
      "fieldScores": { "title": 3, "tags": 4, "description": 2 },
      "skillHits": [
        { "skill": "TypeScript", "score": 5, "fields": ["title", "tags"] },
        { "skill": "React", "score": 4, "fields": ["tags", "description"] }
      ],
      "skillReasons": [
        {
          "skill": "TypeScript",
          "score": 5,
          "fields": ["title", "tags"],
          "kind": "language",
          "depth": "proficient",
          "confidence": 0.9,
          "evidenceRefs": ["ev-001"]
        }
      ],
      "posting": { "jobId": "...", "source": "remoteok", "title": "...", "company": "...", "sourceUrl": "..." }
    }
  ],
  "evidence": {
    "ev-001": { "sourceType": "commit", "url": "https://github.com/...", "claim": "...", "occurredAt": "...", "layer": "L1" }
  },
  "total": 1,
  "candidatePool": 120
}
```

- `profileSkills`：从画像快照提取的技能名（即实际参与匹配的技能集）。
- `matches[]`：打分规则、字段语义与 `POST /job-postings/match` 完全一致（title×3 / tags×2 / description×1，至少命中一个技能才入选，按分降序）。
- **可解释性字段（决策 #10）**：
  - `fieldScores`：分数在标题/标签/正文上的分解，三项之和 = `score`。
  - `skillHits`：每个命中技能各自命中了哪些字段、贡献多少分。
  - `skillReasons`：仅 profileId 匹配时返回，在 `skillHits` 基础上挂画像技能元数据（`kind`/`depth`/`confidence`）与证据指针 `evidenceRefs`。
  - `evidence`：**响应顶层**的去重证据字典，key = `evidenceRef`，供前端回溯证据原链；旧后端可能缺，前端应健壮降级。
- `candidatePool`：过滤后、打分前的候选岗位数，便于解释「为什么只推荐这么少」。
- 画像 `skillTags` 为空时返回 200，`matches` 为空数组（不报错）。

#### 错误

| 码 | 情形 |
| --- | --- |
| 400 | `id` 格式非法，或 query 参数非法（响应带具体字段说明） |
| 404 | 画像不存在（`profile not found`），或画像无快照（`profile has no snapshot`） |

---

## 3.3 职位聚合：岗位检索与画像匹配（P2-D）

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

先用结构化条件取候选池（默认最近 500 条），再按技能名对 title（权重 3）/tags（权重 2）/description（权重 1）做词边界加权打分，按分数降序返回；至少命中一个技能才会出现在结果里。技能来源二选一：直接传 `skills`，或传 `profileId` 由服务端从画像快照取 `skillTags[].name`（**profileId 优先**）；后者响应额外带 `profileSkills` 字段，回显实际参与匹配的技能。

#### 请求体

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `skills` | string[] | **二选一** | 技能名列表；与 `profileId` 至少提供一个，两者都缺返回 400 |
| `profileId` | string | **二选一** | 画像 id；提供后从其快照 `skillTags[].name` 取技能，**优先级高于 `skills`**；画像不存在/无快照返回 404 |
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
// 响应（200，传 profileId 时额外回显 profileSkills 与顶层 evidence）
{
  "matches": [
    {
      "score": 5,
      "matchedSkills": ["Python", "React"],
      "fieldScores": { "title": 3, "tags": 2, "description": 0 },
      "skillHits": [
        { "skill": "Python", "score": 3, "fields": ["title"] },
        { "skill": "React", "score": 2, "fields": ["tags"] }
      ],
      "posting": { "title": "...", "source": "remoteok", "sourceUrl": "..." }
    }
  ],
  "total": 1,
  "profileSkills": ["Python", "React"],
  "evidence": { "ev-001": { "sourceType": "commit", "url": "...", "claim": "..." } }
}
```

- **可解释性字段（决策 #10）**：`fieldScores`（三项和=score）、`skillHits`（逐技能字段级命中）始终返回；`skillReasons`（挂画像元数据与证据指针）与顶层 `evidence` 字典仅在传 `profileId` 时返回；旧后端可能缺可解释字段，调用方应健壮降级。

#### 错误

| 码 | 情形 |
| --- | --- |
| 400 | 非法 JSON；请求体校验失败；`skills` 与 `profileId` 都未提供 |
| 404 | 传了 `profileId` 但画像不存在或无快照 |

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
