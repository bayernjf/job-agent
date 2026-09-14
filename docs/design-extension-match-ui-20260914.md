# 扩展面板匹配 UI 设计（#10 可解释性升级）

> 状态：现行（2026-09-14）
> 前置：[第一档·画像↔岗位匹配接线设计](design-match-wiring-20260914.md) §3（原 top1 轻量方案）、#10 匹配可解释性（`fieldScores`/`skillHits`/`skillReasons`/`evidence` 已贯穿纯函数/API/报告页/扩展类型）
> 范围：仅 `apps/extension` 面板 UI，不改 API、不改 `matchJobs` 纯函数、不新增后端端点

## 0. 背景与目标

### 0.1 现状断层

- `apps/extension/src/lib/api.ts` 已有 `matchJobs(baseUrl, profileId, {limit})` helper，返回 `JobMatchItem[]`，**已透传 #10 全部可解释性字段**（`fieldScores`/`skillHits`/`skillReasons`/`evidence`，旧后端缺字段时可选降级）。
- `apps/extension/src/content/panel.tsx` **完全没有调用 `matchJobs`，也没有匹配 UI**——画像加载后只展示真实性/技能/本地补填/一键填充。
- 原 `design-match-wiring §3` 描述的是"第一档轻量：top1 + 当前岗位 keyword/company 过滤"，但实际连 `extractJobInfo()` 都没实现，面板 UI 整体未落地。
- 报告页 `JobRecommendations.tsx` 已做完整四态 + #10 可解释性（`<details>` 分数分解 + 技能深度 + 证据外链），扩展侧应与之对齐。

### 0.2 目标

在扩展面板（Shadow DOM）的画像结果区，**一键填充按钮上方**新增「岗位匹配」区块：
- 画像加载成功后**自动**调 `matchJobs(profileId, {limit: 5})`，不阻塞一键填充。
- 展示 top 5 匹配岗位列表，每条含：匹配分（三档色）、岗位标题@公司、命中技能 chip、可展开「匹配依据」（分数分解 + 技能深度 + 证据外链，与报告页同构）。
- 四态完整：loading / empty（无匹配或岗位库空）/ error（接口失败）/ list。
- 全部用户可见文案走 `t()`，先加中文 key 再加同构英文 key；颜色/间距/圆角全用 `--ja-*` token，零硬编码 hex。

### 0.3 不做（明确缓做）

- **当前 ATS 岗位精确匹配**（`extractJobInfo()` 从页面 DOM 提取标题/公司，传 `keyword`/`company` 过滤）：第一版不做。原因：①ATS 页面结构差异大，DOM 提取易错；②岗位库是聚合公开岗位，ATS 客户岗位常不在库中，过滤后易为空；③留作第二档（触发条件＝扩展真人试用后用户明确要求"看我当前打开的这个岗匹配度"）。
- **缺失技能精确提取**：需岗位要求技能解析，留 LLM/L2。
- **LLM 匹配理由**：`packages/llm` 未启用。
- **匹配分点击跳转报告页**：扩展内不做跨页面导航，岗位链接直接跳 `sourceUrl`。

## 1. 数据层

### 1.1 复用现有 helper

直接调用 `apps/extension/src/lib/api.ts` 的 `matchJobs()`：

```ts
matchJobs(baseUrl: string, profileId: string, opts?: { limit?: number; fetchImpl?: typeof fetch }): Promise<JobMatchItem[]>
```

- `profileId` 来自 `fetchProfile()` 返回的 `ExportableProfile.id`（确认 `ExportableProfile` 含 `id` 字段；若不含则从 `fetchProfile` 的响应头或存储行补——**实施时先核实**）。
- `limit: 5`（面板空间有限，top5 足够；用户可在报告页看更多）。
- `fetchImpl` 可选注入，便于单测 fake。

### 1.2 响应类型（已存在，重申）

`JobMatchItem`（`lib/api.ts`）：
- `score: number` — 总分（title×3 + tags×2 + description×1）
- `matchedSkills: string[]` — 命中技能名（向后兼容）
- `fieldScores?: { title: number; tags: number; description: number }` — 分数分解（三项和=score）
- `skillHits?: { skill: string; score: number; fields: string[] }[]` — 逐技能命中
- `skillReasons?: { skill, score, fields, kind, depth, confidence, evidenceRefs }[]` — 仅 profileId 匹配时返回，含画像技能元数据与证据指针
- `evidence?: Record<string, { url, claim, occurredAt, layer }>` — 顶层去重证据字典（key=evidenceRef）
- `posting: { jobId, source, title, company, sourceUrl, remote?, salaryMin?, salaryMax? }`

**旧后端健壮降级**：所有可解释字段可选，UI 检测到 `fieldScores` 缺失时只展示总分+命中技能，不崩溃（与报告页 `JobRecommendations` 的回退逻辑一致）。

## 2. UI 设计

### 2.1 布局

在 `panel.tsx` 的画像结果区（`.ja-result`）内，**技能行之后、本地补填 `<details>` 之前**插入「岗位匹配」区块：

```
┌─ .ja-match ─────────────────────────────┐
│  岗位匹配 (5)          [刷新]            │  ← 标题 + 计数 + 刷新按钮
├──────────────────────────────────────────┤
│  ┌─ .ja-match-item ───────────────────┐ │
│  │  92  Senior Frontend @ Acme        │ │  ← 分数(三档色) + 标题@公司
│  │  [React] [TypeScript] [Vite]       │ │  ← 命中技能 chip
│  │  <details> 匹配依据                 │ │  ← 可展开
│  │    分数: title 60 / tags 24 / desc 8│ │
│  │    React: proficient (证据 2) →     │ │  ← 技能深度 + 证据外链
│  │  </details>                          │ │
│  └──────────────────────────────────────┘ │
│  ... (最多 5 条)                           │
└──────────────────────────────────────────┘
```

### 2.2 匹配分三档色（与报告页一致）

| 分数区间 | 色 token | 含义 |
|----------|----------|------|
| ≥ 80% 满分（满分=技能数×6，title×3+tags×2+desc×1） | `--ja-match-high`（语义绿） | 高度匹配 |
| ≥ 40% | `--ja-match-mid`（语义黄/橙） | 部分匹配 |
| < 40% | `--ja-match-low`（语义灰） | 弱覆盖 |

> 满分计算：`matchedSkills.length × 6`（每个技能最多 title3+tags2+desc1=6）。若 `matchedSkills` 为空则不展示分档色（理论上不会，matchJobs 至少命中一技能才返回）。
> token 若 `packages/ui-tokens/tokens.css` 暂无 `--ja-match-*`，则复用现有 `--ja-authenticity-*` 语义色或新增三个语义变量（**实施时核实 token 清单，缺则补**）。

### 2.3 「匹配依据」`<details>`（与报告页同构）

展开后展示：
1. **分数分解**：`title X / tags Y / description Z`（三项和=score），用小 chip 或文本行。
2. **逐技能**：`技能名 · depth(used/proficient) · 命中字段(title/tags/desc) · 证据数`。
   - `skillReasons` 存在时展示 `kind`（language/framework/domain）和 `depth`。
   - 仅有 `skillHits` 时展示 `skill + score + fields`。
   - 两者都缺时只展示 `matchedSkills` 名称。
3. **证据外链**：`skillReasons[].evidenceRefs` 对应的 `evidence[key].url`，渲染为可点击外链（`target="_blank" rel="noopener"`），文本用 `evidence[key].claim` 截短（≤60 字符）。
   - 证据字典在 `JobMatchItem.evidence`（顶层）或响应顶层（**实施时核实 matchJobs 返回结构，evidence 是在 item 内还是响应顶层**）。

### 2.4 四态

| 态 | 触发 | 展示 |
|----|------|------|
| `loading` | 画像加载成功后，`matchJobs` 请求中 | 区块标题 + 骨架行（3 条灰色占位，或文本 `加载中…`） |
| `empty` | `matches.length === 0` | 文本「暂无匹配岗位」（i18n），不展示列表 |
| `error` | `matchJobs` 抛异常 | 文本「匹配加载失败」+ 错误消息（小字），提供「重试」按钮 |
| `list` | 正常返回 | 岗位列表（≤5 条） |

**不阻塞一键填充**：匹配区块独立 state，loading/error/empty 时一键填充按钮始终可用。

### 2.5 刷新按钮

区块标题右侧加「刷新」图标按钮（文本 `↻` 或 i18n `刷新`），点击重新调 `matchJobs`。MVP 阶段画像快照不变时刷新结果不变，但保留按钮便于调试和未来画像更新后重匹配。

## 3. 状态管理（panel.tsx 内）

新增 state：

```ts
const [matchState, setMatchState] = useState<'idle' | 'loading' | 'empty' | 'error' | 'list'>('idle');
const [matches, setMatches] = useState<JobMatchItem[]>([]);
const [matchError, setMatchError] = useState<string | null>(null);
```

在 `handleAnalyze` 成功拿到 `profile` 后，**异步触发** `loadMatches(profile.id)`（不 await，不阻塞 setProfile）：

```ts
async function loadMatches(profileId: string): Promise<void> {
  setMatchState('loading');
  try {
    const api = new JobAgentApi({ baseUrl: apiBase.replace(/\/$/, '') });
    const list = await matchJobs(apiBase.replace(/\/$/, ''), profileId, { limit: 5 });
    setMatches(list);
    setMatchState(list.length > 0 ? 'list' : 'empty');
  } catch (err) {
    setMatchError((err as Error).message);
    setMatchState('error');
  }
}
```

- 切换用户/重新分析时，重置 `matchState='idle'` + `matches=[]`。
- `profile` 为 null 时不展示匹配区块。

## 4. i18n

新增 key（先中文后英文，与扩展现有字典结构对齐）：

| key | 中文 | 英文 |
|-----|------|------|
| `match.title` | 岗位匹配 | Job Matches |
| `match.loading` | 加载中… | Loading… |
| `match.empty` | 暂无匹配岗位 | No matching jobs |
| `match.error` | 匹配加载失败 | Failed to load matches |
| `match.retry` | 重试 | Retry |
| `match.refresh` | 刷新 | Refresh |
| `match.basis` | 匹配依据 | Why this matches |
| `match.scoreBreakdown` | 分数分解 | Score breakdown |
| `match.evidence` | 证据 | Evidence |
| `match.high` | 高度匹配 | High match |
| `match.mid` | 部分匹配 | Partial match |
| `match.low` | 弱覆盖 | Weak match |

> 实施时核对扩展现有 `apps/extension/src/i18n/messages/{zh-CN,en}.json` 的 key 命名风格（用 `.` 分隔还是 `_`），保持一致。现有 key 如 `panel.title`/`fill.skillSeparator`，故用 `.` 分隔。

## 5. 设计 token

- 全部颜色/间距/圆角/阴影用 `packages/ui-tokens/tokens.css` 的 `--ja-*` 变量。
- 匹配分三档色：优先复用现有 `--ja-authenticity-likely_authentic`（绿）/`--ja-authenticity-mixed_signals`（黄）/`--ja-authenticity-insufficient_data`（灰）；若语义不匹配则新增 `--ja-match-high/mid/low`。
- 岗位卡片用 `--ja-border` + `--ja-radius-md` + `--ja-bg-elevated`（若存在）。
- 命中技能 chip 复用报告页 `.ja-tag` 样式（若扩展 panel.css 已有则复用，否则按 token 新写）。
- **零硬编码 hex/rgb/hsl**，由 `tokens-guard.test.ts` 守护。

## 6. 测试

### 6.1 单测（Vitest，就近放置）

新增 `apps/extension/src/content/panel-match.test.tsx`（或在现有 panel 测试文件中追加）：
- **loading 态**：fake fetch 延迟返回，断言展示 loading 文本。
- **list 态**：fake 返回 3 条 match，断言渲染 3 个 `.ja-match-item`，含分数/标题/命中技能。
- **可解释性展开**：fake 返回含 `fieldScores`/`skillReasons`/`evidence` 的 match，断言 `<details>` 展开后展示分数分解和证据外链。
- **旧后端降级**：fake 返回仅 `score/matchedSkills/posting`（无可解释字段），断言不崩溃、只展示总分+技能。
- **empty 态**：fake 返回 `[]`，断言展示 empty 文本。
- **error 态**：fake fetch reject，断言展示 error 文本 + 重试按钮。
- **不阻塞填充**：匹配 loading 时，一键填充按钮仍可点击（断言 disabled=false）。

测试用 `@testing-library/react`（若扩展已引入则复用，否则需加 devDependency——**实施时核实**）或直接 shallow render。fake fetch 通过 `matchJobs` 的 `fetchImpl` 参数注入。

### 6.2 构建验证

- `pnpm --filter @jobagent/extension typecheck`
- `pnpm --filter @jobagent/extension build`（esbuild，确认 dist 产物含新代码）
- `pnpm --filter @jobagent/extension test`

### 6.3 真实环境冒烟（可选，留后续）

Playwright 加载 unpacked 扩展，访问真实 Greenhouse 岗位页，输入用户名拉画像，断言匹配区块渲染。此步留作扩展真人试用阶段，MVP 代码阶段不强制。

## 7. 实施顺序（原子提交）

1. **`feat(extension): add match section to panel with four states`** — panel.tsx 新增 match state + `loadMatches` + 四态渲染（列表+分数+技能+`<details>`匹配依据），i18n key 中英同构，panel.css 新样式全 token。
2. **`test(extension): cover panel match four states and explainability fallback`** — 单测覆盖 loading/list/可解释展开/旧后端降级/empty/error/不阻塞填充。
3. **`docs(api): document #10 explainability fields in match endpoints`** — API.md 3.2/3.3 响应示例补 `fieldScores`/`skillHits`/`skillReasons`/`evidence`。
4. **`feat(cli): show fieldScores and skillHits in jobs match output`** — CLI TSV 加命中技能列，JSON 输出完整可解释字段，更新测试。
5. **`docs(handoff): record extension match UI completion and update active todos`** — handoff 更新。

> 提交 1/2 是任务 1+4，提交 3 是任务 2，提交 4 是任务 3，提交 5 是 handoff。共 5 个原子提交。

## 8. 验收标准

- [ ] 扩展面板画像加载后自动展示「岗位匹配」区块，top5 列表渲染正确。
- [ ] 每条匹配含分数（三档色）、标题@公司、命中技能 chip。
- [ ] 「匹配依据」展开后展示分数分解 + 技能深度 + 证据外链。
- [ ] 旧后端（无可解释字段）响应不崩溃，降级展示总分+技能。
- [ ] 四态（loading/empty/error/list）完整，error 有重试按钮。
- [ ] 匹配加载不阻塞一键填充按钮。
- [ ] 全部用户可见文案走 `t()`，中英 key 对齐（i18n 测试守护）。
- [ ] panel.css 零硬编码 hex（tokens-guard 守护）。
- [ ] 单测全绿，extension typecheck/build 通过。
- [ ] API.md 响应示例含 #10 可解释性字段。
- [ ] CLI `jobs match` 输出含 fieldScores/skillHits（JSON 完整，TSV 加命中技能列）。
- [ ] handoff 已更新。

## 9. 未决与待核实

- **`ExportableProfile.id` 字段**：实施时核实 `fetchProfile()` 返回的 `ExportableProfile` 是否含 `id`。若不含，需从 API 响应补（`GET /profiles/:id/exportable` 应返回 id）。
- **`evidence` 位置**：核实 `matchJobs` 返回的 `JobMatchItem` 中 `evidence` 是在每个 item 内还是响应顶层（`{matches, evidence}`）。报告页 `JobRecommendations` 的消费方式可作参考。
- **匹配分三档 token**：核实 `packages/ui-tokens/tokens.css` 是否有合适的语义色变量，缺则补。
- **测试框架**：核实扩展是否已引入 `@testing-library/react`，缺则加 devDependency（仅测试依赖，不进产物）。
- **当前 ATS 岗位精确匹配**：留第二档，触发条件＝扩展真人试用后用户明确要求。
