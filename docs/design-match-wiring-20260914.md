# 第一档·画像 ↔ 岗位匹配接线设计

> 状态：现行（2026-09-14 启动）。P2-D 已落地 `matchJobs` 纯函数与 `POST /job-postings/match`（手动传技能），本设计把「能力画像」自动接上，形成端到端「可信画像 → 匹配 → 推荐/投递」闭环。对应 handoff「第一档」。

## 0. 基线与不做

- 已有：`packages/job-source/src/match/job-match.ts`（纯函数，title×3/tags×2/description×1 词边界加权，硬过滤 remote/salary/sources，至少命中一技能才返回）；`POST /job-postings/match`（手动 `skills` 必填）；`GET /profiles/:id` 返回完整 `AbilityProfile`，其中 `skillTags: SkillTag[]`（name/kind/depth/evidenceRefs）。
- **不做**：语义向量召回、LLM 生成匹配理由、岗位要求技能反向提取（"缺失技能"精确版）、跨源同岗合并、全自动后台投递。匹配理由第一档只展示「命中的画像技能 + 加权分」，可回溯到 `skillTags.evidenceRefs`（呼应 #10，轻量版）。

## 1. API 接线（①）

### 1.1 新增 `GET /profiles/:id/job-recommendations`

报告页友好的只读端点，语义是「这个画像推荐什么岗位」。

- Query（全部可选）：
  - `remote`：`true|false`，硬过滤
  - `sources`：逗号分隔，逐个用 `JobSourceSchema` 校验，非法 400
  - `salary_min`：非负整数，硬过滤 `COALESCE(salaryMax,salaryMin) >= n`
  - `limit`：返回上限，默认 20，最大 100
  - `candidate_limit`：候选池上限，默认 500，最大 500
- 流程：
  1. `ProfileIdParamSchema` 校验；`repos.profiles.getById(id)`，不存在 404；`snapshot` 为 null 404（画像未完成或快照损坏）。
  2. 取 `skills = snapshot.skillTags.map(t => t.name)`；为空时直接返回 `{ profileSkills: [], matches: [] }`（200，不是错误——画像可能还没产出技能标签）。
  3. `repos.jobPostings.search({ sources, remote, salaryMinUsd, limit: candidateLimit, orderBy: 'posted_desc' })` 取候选池。
  4. `matchJobs(candidates, { skills, remote, salaryMinUsd, sources, limit })` 打分排序。
- 响应：
  ```json
  {
    "profileId": "...",
    "profileSkills": ["TypeScript", "React", ...],
    "matches": [
      { "score": 9, "matchedSkills": ["TypeScript", "React"], "posting": { ...StoredJobPosting } }
    ],
    "total": 12,
    "candidatePool": 320
  }
  ```
- 路由注册位置：在 `GET /profiles/:id/exportable` 之后、`GET /profiles/:id` 不会冲突（路径更长优先，Hono 按注册顺序，`job-recommendations` 是字面量不会被 `:id` 吞——但为安全放在 `:id` 路由之前或之后均可，Hono 字面量优先）。

### 1.2 `POST /job-postings/match` 接受可选 `profileId`

复用现有端点，供扩展/其他客户端使用。`JobMatchRequestSchema` 改为 `skills` 与 `profileId` 二选一：

- `profileId`：字符串，非空；提供时忽略 `skills`，从 `repos.profiles.getById` 取技能。
- 校验：两者都缺 → 400 `either skills or profileId is required`；profileId 不存在 → 404；snapshot null → 404；skillTags 空 → 返回空 matches（200）。
- 其余候选池过滤/打分逻辑不变。

### 1.3 测试

- `GET /profiles/:id/job-recommendations`：正常返回排序+命中技能；profile 不存在 404；snapshot null 404；skillTags 空返回空数组；非法 source 400；remote/salary 硬过滤生效。
- `POST /job-postings/match` with profileId：正常；profileId 与 skills 同传时 profileId 优先；都缺 400。

## 2. 报告页推荐区块（②）

### 2.1 组件

新增 `apps/report/src/components/JobRecommendations.tsx`（React island，`client:load`），props：`profileId: string`、`locale: string`、`apiBase: string`（从环境变量或 Astro 注入，报告页 SSR 已有 `PUBLIC_API_BASE` 约定，见落地页接线；report 自身 API base 用相对路径 `/api` 或环境变量，先看现有 report 怎么调 API——AnalyzeForm 用 `data-api-base`，沿用同一机制）。

### 2.2 行为

- mount 后 `fetch(`${apiBase}/profiles/${profileId}/job-recommendations?limit=10`)`。
- loading / error / empty 三态；empty 文案走 i18n。
- 列表展示 top 10（可配），每条：
  - 匹配分（数字，或简单的进度条/星级，第一档用数字 + 颜色映射真实性四态色板的语义色，不新增色）
  - 命中技能（chip 列表，hover 或展开显示 evidenceRefs 链接——第一档轻量：chip 可点击跳 `evidenceRefs` 第一个 URL，无则不可点）
  - 标题 @ 公司（点击跳 `posting.sourceUrl`，新窗口）
  - 地点 / 远程标签 / 薪资（如有）
  - 发布时间（相对或日期，`Intl`）
- 不做分页/无限滚动（第一档 top N 足够）。

### 2.3 页面接入

`apps/report/src/pages/[locale]/report/[profileId].astro`：在报告主体（面试题区块之后、局限之前，或能力标签之后）插入 `<JobRecommendations client:load profileId={...} locale={...} apiBase={...} />`。SSR 侧先判断画像是否有 skillTags，无则不渲染 island（避免空请求）——但 island 内部也会处理 empty，SSR 可简化为始终渲染。

### 2.4 i18n

新增 key（zh-CN 先加，en 同构，一致性测试守护）：
- `recommendations.title` / `recommendations.loading` / `recommendations.error` / `recommendations.empty`
- `recommendations.score` / `recommendations.matchedSkills` / `recommendations.viewJob` / `recommendations.candidateCount`

### 2.5 设计 token

颜色/间距/圆角/阴影全用 `--ja-*` CSS 变量，禁止 hex；chip/卡片样式复用 global.css 工具类或新增语义类，不散落硬编码尺寸。

## 3. 扩展侧栏匹配度（③）

### 3.1 触发与数据

扩展侧栏（Shadow DOM 面板）在 ATS 岗位页（Greenhouse/Lever/Workday）展示。当前岗位信息来源：
- Greenhouse/Lever：页面 URL 含 job board slug + job id，可从 DOM 提取标题/公司/描述（content script 已有 `findFields` 等 DOM 能力，新增 `extractJobInfo()`）。
- 第一档轻量方案：**不调后端匹配当前单岗**，而是用扩展已拉取的画像（`GET /profiles/:id/exportable` 的 skills）在前端对「当前页面提取的岗位文本」用 `matchJobs` 同款逻辑计算——但 `matchJobs` 在 `@jobagent/job-source`，扩展是独立 esbuild 工程，引入 workspace 包需配置。
- **更简单的第一档方案**：侧栏调 `POST /job-postings/match`，传 `profileId` + `keyword`（当前岗位标题关键词）+ `company`，取返回的 matches 中与当前岗位最匹配的一条（或 top 1），展示其 score + matchedSkills。这复用①的端点，不新增前端匹配逻辑。
- 若当前岗位不在岗位库中（库是聚合的公开岗位，ATS 客户岗位可能不在库），则显示「当前岗位未在岗位库中，无法计算匹配度」（empty 态），不阻塞一键填充。

### 3.2 展示

侧栏在「一键填充」按钮上方或下方加「岗位匹配度」区块：
- 匹配分（数字 + 简短描述，如「高度匹配 / 部分匹配 / 未覆盖」）
- 命中技能（chip）
- 「缺失技能」第一档**不做精确提取**，标注为缓做（需要岗位要求技能解析，留 LLM 或 L2）；可轻量展示「画像技能中未在本岗命中的数量」作为参考，但不称「缺失」。
- 与一键填充合流：匹配度区块不影响填充行为，仅展示。

### 3.3 测试

- 扩展单元测试：`extractJobInfo` 对 Greenhouse/Lever DOM 夹具提取标题/公司；匹配度区块渲染 loading/error/empty/matched 四态（用 fake fetch）。
- 真实环境冒烟留后续（Greenhouse/Lever 真实页）。

## 4. 验收

- ①API：`GET /profiles/:id/job-recommendations` 对真实画像（如 bayernjf）返回按技能匹配的岗位列表，排序正确，命中技能可回溯；`POST /job-postings/match` 传 profileId 与传 skills 结果一致。
- ②报告页：真实报告页渲染推荐区块，中英双语无 `[missing:]`，点击岗位跳 sourceUrl，无硬编码 hex。
- ③扩展：Greenhouse 真实岗位页侧栏显示匹配度（若岗位在库），不阻塞一键填充。
- 全仓 `pnpm -r typecheck/test/build` 全绿，`git diff --check` 通过，原子提交。

## 5. 未决与缓做

- 「缺失技能」精确版（岗位要求技能提取 + 画像差集）：缓做，需 LLM 或规则解析岗位描述，触发条件：第一档上线后用户反馈需要。
- 匹配理由自然语言（LLM 生成「为什么推荐」）：缓做，`packages/llm` 启用后再做，且必须结构化校验。
- 向量召回/语义近似：缓做，当前词边界匹配覆盖技术岗精确技能名，召回不足时再评估。
- 扩展在 Workday 真实页的匹配度冒烟：Workday 平台侧受限（见 handoff），待拿到直渲染表单租户再验证。
