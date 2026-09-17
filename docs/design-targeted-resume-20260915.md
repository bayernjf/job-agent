# 设计：岗位定向简历生成（Targeted Resume）

- 状态：现行（**P-R1 规则版闭环 2026-09-15 落地；P-R2 在线消费 + P-R3 可纯代码闭环子项 2026-09-16 落地**：shared 契约 + `packages/resume-core`（含 polish 安全层）+ `packages/llm`（端口/fake/OpenAI 兼容 client/env 工厂，默认关闭）+ CLI `resume build`/`batch` + API `POST /resumes/build`（含可选 `polish`）+ 报告页 ResumeBuilder island（含 `?resumeJob=` 深链）+ 扩展面板深链 CTA。**§10 五项 2026-09-16 已决策**：不持久化、只存本机、浏览器打印 PDF、LLM 默认关闭+OpenAI 兼容自配、语言手选；版本管理入 deferred。**本地档案 canonical 统一已落地（item19 ①，2026-09-16，见 §5.4.1），跨端自动互通已落地（item24，2026-09-17，见 §5.4.1）**）
- 日期：2026-09-15
- 需求来源：用户需求——"在求职者的画像范围内，针对不同职位，生成匹配度高的简历"
- 关联：[PRD.md](PRD.md)、[design-match-wiring-20260914.md](design-match-wiring-20260914.md)（画像↔岗位匹配）、[design-job-ingestion-20260913.md](design-job-ingestion-20260913.md)（岗位库）、[讨论记录-02](讨论记录-02-投递功能与竞品分析-20260911.md)（竞品简历定制）

## 0. 定位、基线与不做

### 0.1 一句话定位

给定**可信画像**（AbilityProfile + EvidenceItem）与**目标岗位**（JobPosting + 匹配结果），产出一份**针对该岗位优化、但每个断言都严格限定在画像证据范围内**的简历。竞品（Jobright/LoopCV/Simplify）的简历定制是"AI 自由改写、可插入不存在的技能"（Reddit 大量幻觉投诉，见讨论记录-02）；本功能的差异化是 **"岗位定向重排，绝不新增事实，每条可回溯 GitHub 证据"**。

### 0.2 三条铁律（不可违反，测试守护）

1. **画像范围硬约束（no-fabrication）**：简历中每个技能、每条经历、每个数字都必须来自画像或用户显式补填，且可追溯到 evidenceRefs；禁止生成画像外的技能、指标、公司、年限。岗位要求但画像没有的内容，只能进"建议补充"提示区，**绝不替用户编造**。
2. **定向 = 选择 + 排序 + 模板组装，不是改写事实**：针对岗位做的是命中技能前置、支撑证据前置、headline 模板化；画像事实原文不被篡改。
3. **可复核（provenance）**：ResumeDraft 每个 section/条目携带 evidenceRefs 与 analyzerVersion/规则版本，用户可逐条回溯到 commit/PR/Issue 原始 URL。

### 0.3 明确不做（本期）

- 不做全自动后台投递（PRD 非目标，不变）。
- 不做 LLM 自由写作式简历生成（B 档仅允许"结构化结果上的受约束润色"，见 §7；已实现但**默认关闭**，需请求显式 `polish:true` 且服务端配置 LLM env 才启用）。
- 不做服务端简历持久化（P-R2 前按需生成、不落库；是否持久化列入待拍板 §10）。
- 不替用户编造教育/工作经历/联系方式——画像不提供这些，走"本地补填"通道（§5.4），缺则显式占位。
- 不做向量语义召回；岗位匹配仍用既有 `matchJobs` 词边界匹配。

## 1. 现有积木与缺口

| 能力 | 现状 | 本功能复用方式 |
| --- | --- | --- |
| 可信画像 | `AbilityProfile`（skillTags 带 depth/confidence/evidenceRefs、summary、collaboration、authenticity） | 简历事实唯一来源 |
| 完整证据 | storage `evidence` 表 EvidenceItem（claim/url/sourceType/occurredAt/rawRef） | "项目/经历"条目来源，由 evidenceRefs 反查 |
| 岗位库 | `job_postings` 表 + JobPosting | 目标岗位 |
| 匹配引擎 | `matchJobs`（score/fieldScores/matchedSkills/skillHits） | 定向排序的驱动信号 |
| 分档 | shared `matchScoreTier` | 简历头部匹配度徽标 |
| 导出渲染 | CLI `report-format.ts` 纯函数 toMarkdown/toHtml（含 XSS 转义） | 简历渲染照此模式 |
| 本地补填 | 扩展 LocalFields（email/phone 等仅存本机 localStorage） | 画像外字段补填通道 |
| LLM 端口 | `packages/llm` 已实现：端口 + Fake + OpenAI 兼容 client + 润色 adapter | B 档润色默认关闭，配 `LLM_*` env 且 `polish:true` 才启用（§7/§10 #4） |
| **缺口** | 无简历装配内核、无 ResumeDraft 契约、无渲染、无消费入口 | 本设计补齐 |

## 2. 总体架构

延续 analyzer-core / job-source 的"**纯函数内核 + 薄消费层**"模式，内核零 I/O、可对固定夹具单测：

```text
目标岗位 JobPosting ──► matchJobs（已有）──► JobMatch(matchedSkills/skillHits/fieldScores)
                                                         │
可信画像 AbilityProfile + EvidenceItem[] ────────────────┤
用户本地补填 LocalResumeFields（教育/经历/联系方式，可选）─┤
                                                         ▼
                              packages/resume-core（新增，纯函数、零 I/O）
                                   tailor.ts: buildResume() ──► ResumeDraft（结构化、带证据）
                                   rank.ts: 技能/证据岗位定向排序
                                                         │
                                            render/markdown.ts · html.ts
                                                         ▼
                                            Markdown / 可打印 HTML（ATS 友好）
消费层：P-R1 CLI `resume build`  →  P-R2 API + 报告页入口  →  P-R3 缓做（扩展/LLM）
```

### 2.1 为什么新建 `packages/resume-core` 而不是塞进 analyzer-core / job-source

- analyzer-core 是"GitHub 行为 → 画像"的分析内核，不应依赖"岗位/简历"概念（B-5 融合、行为多样性都刻意保持它纯净）。
- job-source 负责岗位采集与"岗位 × 技能"匹配，简历是**画像侧消费**，反向依赖不合适。
- resume-core 同时依赖 shared 的画像契约与岗位契约，是独立的纯函数装配层，与两包平级，测试不打网络/不读库。

## 3. 数据契约（落 `packages/shared`，单一事实源）

> 对齐 AGENTS「共享类型只放 shared」；Zod schema + `z.infer`，风格同 AbilityProfile/JobPosting。

```ts
/** 简历规则版本（排序/模板逻辑变更时递增，写入 provenance 保证可复现） */
export const RESUME_RULE_VERSION = '0.1';

/** 用户本地补填字段（画像不提供；仅本机/请求时传入，服务端不持久化） */
export const LocalResumeFieldsSchema = z.object({
  fullName: z.string().optional(),
  email: z.string().optional(),
  phone: z.string().optional(),
  location: z.string().optional(),
  personalSite: z.string().url().optional(),
  education: z.array(z.object({ school: z.string(), degree: z.string(), period: z.string().optional() })).optional(),
  workHistory: z.array(z.object({ company: z.string(), role: z.string(), period: z.string().optional(), detail: z.string().optional() })).optional(),
});
export type LocalResumeFields = z.infer<typeof LocalResumeFieldsSchema>;

/** 一条可回溯的简历条目（技能或经历），refs 必须非空（本地补填项除外，标 source:'local'） */
export const ResumeEntrySchema = z.object({
  text: z.string().min(1),               // 展示文本（来自画像 claim / 技能名 / 本地补填，不新造）
  evidenceRefs: z.array(z.string()),     // -> EvidenceItem.evidenceId；本地补填为空数组
  source: z.enum(['profile', 'local']),
  url: z.string().url().optional(),      // 证据原始 URL（commit/PR/Issue）
  occurredAt: z.string().optional(),
  supportsSkills: z.array(z.string()).default([]), // 该条目支撑哪些"命中技能"
});

export const ResumeDraftSchema = z.object({
  schemaVersion: z.string().min(1),
  ruleVersion: z.string().min(1),
  generatedAt: z.string().datetime(),
  subject: z.object({ login: z.string(), displayName: z.string().optional(), profileUrl: z.string().url() }),
  targetJob: z.object({
    jobId: z.string().min(1), title: z.string().min(1), company: z.string().min(1),
    sourceUrl: z.string().url(), matchScore: z.number(), tier: z.enum(['high', 'mid', 'low']), // 与 shared MatchScoreTier 同值，分档用 matchScoreTier()
    matchedSkills: z.array(z.string()), fieldScores: z.object({ title: z.number(), tags: z.number(), description: z.number() }),
  }),
  header: z.object({ name: z.string(), headline: z.string(), contact: z.record(z.string()).optional() }),
  summary: z.string().min(1),                                  // 岗位定向概述（模板组装，见 §4.3）
  matchedSkills: z.array(ResumeEntrySchema),                   // 岗位命中、置顶
  otherSkills: z.array(ResumeEntrySchema),                     // 画像有、岗位未提（保留不删，排序在后）
  evidenceHighlights: z.array(ResumeEntrySchema),              // 支撑命中技能的证据/项目，按强度排序
  collaboration: z.array(ResumeEntrySchema).default([]),       // 外部 merged PR 等强信号
  localSections: z.object({ education: z.array(ResumeEntrySchema).default([]), workHistory: z.array(ResumeEntrySchema).default([]) }),
  suggestions: z.array(z.object({ kind: z.enum(['missing_skill', 'missing_field', 'low_match']), text: z.string() })),
  gaps: z.array(z.string()),                                   // 画像缺失、需用户补填的字段
  provenance: z.object({ analyzerVersion: z.string(), profileId: z.string(), ruleVersion: z.string() }),
});
export type ResumeDraft = z.infer<typeof ResumeDraftSchema>;
```

**契约要点**：
- `matchedSkills` 与 `otherSkills` 分开——岗位命中的置顶做 ATS 关键词覆盖，画像其余技能保留（不丢事实）但排后。
- 每条 `ResumeEntry` 强制 `source` 与 `evidenceRefs`，是 no-fabrication 的结构化抓手（§6 测试据此断言"输出 refs ⊆ 输入证据集合"）。
- `suggestions` 只**提示**岗位要求但画像缺失的技能/字段，不把它们写进简历正文。

## 4. 内核设计（`packages/resume-core`）

### 4.1 `rank.ts`：岗位定向排序（纯函数）

**技能排序**
1. 画像 skillTags 与 match.matchedSkills 求交 → `matchedSkills`，顺序按 skillHits.score 降序（岗位标题命中的技能排最前），同分时按画像 confidence/depth（proficient > used）。
2. 其余 skillTags → `otherSkills`，按 depth、confidence 降序。
3. 同名归一（大小写/别名以技能词典为准，复用 B-4 skills-catalog 的别名表）。

**证据/项目排序（evidenceHighlights）**
1. 收集所有命中技能的 evidenceRefs 并集，反查输入 EvidenceItem[]。
2. 证据强度权重：外部 merged PR（collaboration.externalMergedContributions）> PR > Issue > commit；同强度按 occurredAt 新→旧。
3. 每条证据标注 `supportsSkills`（它支撑哪些命中技能）；支撑越多命中技能越靠前。
4. 截断上限（默认 highlights ≤ 10 条，可配），避免简历变证据流水账；被截断的不丢，渲染时可折叠。

### 4.2 `tailor.ts`：`buildResume()`（纯函数，唯一装配入口）

```ts
export interface BuildResumeInput {
  profile: AbilityProfile;
  evidence: EvidenceItem[];          // storage 反查；CLI 可由 profile JSON + evidence JSON 喂入
  posting: JobPosting;
  match: JobMatch;                  // 调用方先用 matchJobs 算好（内核不重复匹配）
  local?: LocalResumeFields;        // 用户补填，可选
  options?: { highlightLimit?: number; locale?: 'zh-CN' | 'en' };
}
export function buildResume(input: BuildResumeInput): ResumeDraft;
```

步骤：校验输入（Zod）→ rank 排序 → 组装各 section → 生成 summary/headline → 计算 suggestions/gaps → 产出 ResumeDraft。**无网络、无 DB、无随机、无当前时间以外的副作用**（generatedAt 可注入以便测试确定性）。

### 4.3 岗位定向 summary / headline（规则模板，A 档不用 LLM）

模板槽位**全部**来自画像与匹配结果，不新增事实：

- headline：`画像.summary.headline`（已有，分析内核产出）为主；可选追加"面向 {岗位标准职能词}"的限定，职能词只从 posting.title 做受控词映射（如 "Backend Engineer"→后端方向），不照抄营销话术。
- summary 句式（locale 分中英模板）：
  `{seniorityHint.band | headline}，在数据窗 {since}–{until} 内以 {命中技能 top3} 为核心，{externalMergedContributions 数量/协作结论}；本次针对「{posting.title} @ {company}」突出 {matchedSkills top N}。`
- 画像缺 seniorityHint / collaboration 时对应分句省略（不写空、不编）。
- 所有数字只能来自 `activity.metrics`/collaboration 等画像既有字段。

### 4.4 suggestions / gaps（诚实边界）

- `missing_skill`：posting.tags/title 中出现、但画像 skillTags 没有的技能 → 提示"岗位提及 X，画像未检出，如确有经验请在补填中说明"，**不进正文**。
- `missing_field`：local 未提供 email/教育/工作经历 → gaps 列出，渲染为"待补充"占位，提醒用户。
- `low_match`：matchScoreTier 为 low 时提示匹配度偏低、列出 fieldScores 分解，让用户知情而非硬凑。

## 5. 渲染与补填

### 5.1 Markdown / HTML（纯函数，照 report-format 模式）

- `renderMarkdown(draft): string`：单栏、标准 section 标题（Summary / Skills / Experience / Projects / Education），ATS 友好（无表格布局、无图标文字、标准字体）。
- `renderHtml(draft): string`：带 `@media print` 打印 CSS（A4、分页不断行），用户浏览器"打印→另存 PDF"即可得 PDF，**不引 puppeteer 等重依赖**；颜色只消费 `packages/ui-tokens` 的 `--ja-*`，禁硬编码 hex（对齐 token 规则）。
- HTML 对所有外部文本做 XSS 转义（report-format 已有 escapeHtml 可提取共享）。
- 证据条目渲染为可点外链（commit/PR URL），并在页脚列 provenance（profileId/analyzerVersion/ruleVersion/生成时间）。
- 用户可见文案走 i18n（中英 key 同构，对齐 design-i18n：先 zh-CN key 再 en key、key 对齐测试）。

### 5.2 匹配度徽标

header 展示 matchScoreTier（high/mid/low，颜色用 shared.matchScoreTier 与既有三档色）+ fieldScores 分解（标题/标签/正文各贡献多少），让用户知道"这份简历为何针对该岗"。

### 5.3 ATS 友好约束

单栏、标准标题层级、技能名以规范全称出现（别名归一后的标准名，如 k8s→kubernetes 同时保留用户惯用写法括号注）、不用文本图片、不用多列/文本框。

### 5.4 本地补填通道

画像不提供 email/电话/教育/工作经历（与扩展 ExportableProfile 的边界一致）。三端各自落地：
- CLI：`--local-fields path.json`（可选），缺则产出带 gaps 占位的简历。
- API：请求体可选 `local` 字段，**不入库、不记日志**。
- 报告页（P-R2）：浏览器 localStorage 存补填，仅在请求时随 `local` 上送。
- 扩展面板：ATS 填充用本地字段存于 content script 所在页面域的 localStorage。

#### 5.4.1 统一本地档案 canonical（item19 ①，2026-09-16 落地）

报告页与扩展原先各持一份形状不同、key 不同的本地字段，现统一为 **shared 单一 canonical 契约 `LocalProfileFields`**，两端都存同一份形状（各自本机存储，**仍不跨域自动同步**，理由见末段）。

```ts
// packages/shared，Zod 单一事实源
LocalProfileEducation = { school(必填), degree?, start?, end? }
LocalProfileWork     = { company(必填), role?, start?, end?, detail? }
LocalProfileFields   = {
  fullName?, email?, phone?, location?, personalSite?(url), linkedinUrl?(url),
  education?: LocalProfileEducation[], workHistory?: LocalProfileWork[],
}
```

- **时间一律结构化 `start/end`**（宽松字符串，不强校验日期，兼容 "2018-09" / "2022" / "至今"）；两端表单都采集 start/end 两个输入。
- **两个纯函数投影**（shared，零 I/O、可单测）：
  - `localProfileToResumeFields(c) → LocalResumeFields`：简历是 canonical 的**严格投影**。`personalSite ?? linkedinUrl` 落到唯一 URL 槽；`period = formatRange(start,end)`；教育项必须同时有 `school+degree`、工作项必须同时有 `company+role` 否则**过滤不臆造**（简历 Zod 要求 degree/role 非空）；`detail` 保留。
  - `localProfileToAtsFields(c) → LocalAtsFields`：`workHistory.role → experience.title`，只取 ATS 有槽位的字段（email/phone/location/linkedinUrl/education/experience）；`fullName/personalSite/detail` 无 ATS 槽位丢弃（fullName 仍用画像 displayName/login）。ATS 侧 `LocalFields` 类型改为从 shared 导入 `LocalAtsFields`，不再在扩展内自定义。
- **存储与一次性迁移**：两端统一写 canonical key **`jobagent.localProfile`**。
  - 报告页首次读取：无 canonical 时读旧 `jobagent.localResumeFields`，经 `legacyResumeToLocalProfile` 转换（自由文本 `period` 用 `splitRange` 按 `– — - ～ ~ 至 到` 切回 start/end，切不出则整段入 start，**不丢字符**），写 canonical 后删旧 key。
  - 扩展首次读取：无 canonical 时读旧 `jobagent.localFields`，经 `legacyAtsToLocalProfile` 转换（`experience.title → workHistory.role`，start/end 直映），写 canonical 后删旧 key。
  - 迁移在各端**本域内**发生（报告页产品域读不到 ATS 第三方域的 localStorage，反之亦然）；shared 另提供 `mergeLocalProfile(a,b)` 纯函数支持字段级合并/数组拼接去重，供未来通道与测试使用，当前运行时每端只有一份 legacy。
  - localStorage 读写薄壳留在组件/panel（shared 不碰 DOM）；localStorage 不可用时 try/catch 降级为本次会话内存态。
- **边界 → 已落地（2026-09-17，见 handoff item24）**：~~扩展 content script 在第三方 ATS 域、报告页在产品域，叠加 §10 #1 服务端不持久化，二者物理上无法共享 localStorage 自动同步~~ 跨端自动互通已通过扩展 `chrome.storage` + `externally_connectable` 通道打通：固定扩展 ID（manifest `key` 派生）+ background 消息处理（GET/SET），两端经 chrome.storage.local（跨域权威）自动合并、本域 localStorage 仅降级缓存；本次 schema 统一正是该通道就绪的基础。

## 6. 测试策略（确定性，对齐 analyzer-core 优先级）

`packages/resume-core/src/*.test.ts`，夹具为固定 AbilityProfile + EvidenceItem + JobPosting：

1. **no-fabrication 不变量（最重要）**：遍历输出所有 ResumeEntry，断言 `source:'profile'` 条目的 evidenceRefs ⊆ 输入 evidence id 集合；text 中出现的技能名 ⊆ 画像技能名 ∪ 本地补填；任何数字 token 必能在画像字段找到来源。
2. 定向排序：命中技能置顶且顺序 = skillHits.score 降序；支撑多命中技能的证据排前；外部 merged PR 权重最高。
3. summary/headline：槽位全部可回溯；缺 seniority/collaboration 时正确省略、不出现空模板痕迹。
4. 降级：画像零技能 / match 零命中（tier=low）/ evidence 缺失 / local 全空，均产出结构完整草稿并正确给 gaps/suggestions，不抛异常。
5. 渲染：md/html 快照；XSS 转义（证据 claim 含 `<script>` 被转义）；打印 CSS 存在。
6. i18n：中英 key 对齐一致性测试（同 report 既有守护）。
7. CLI 集成：`resume build` 对夹具 profile+job 产出 md/html 文件、`--format json` 输出 ResumeDraft。

## 7. B 档：LLM 受约束润色（已实现，默认关闭）

**状态（2026-09-16，§10 #4 已决策）**：不再是"仅预留端口"。已落地 provider-agnostic 的 OpenAI 兼容客户端 `packages/llm/src/openai-compatible-client.ts`（一个实现覆盖 OpenAI / DeepSeek / 通义兼容模式 / 智谱、Moonshot 兼容网关 / 本地 vLLM 等），由服务端 env `LLM_API_KEY` + `LLM_MODEL`（可选 `LLM_BASE_URL`/`LLM_PROVIDER`/`LLM_TIMEOUT_MS`）配置；**未配置 key 时默认关闭、走纯规则版，零费用、零数据外发**，不锁定具体付费厂商、不内置单价。API `POST /resumes/build` 仅在请求体 `polish:true` 时调用，未配置/任何失败都回退规则版并在响应 `polish` 字段如实标注（见 docs/API.md §3.4）。**报告页「AI 润色措辞」开关 UI 已落地（2026-09-16，handoff item19 ②）**：ResumeBuilder 勾选即带 `polish:true` 重新生成、下载 Markdown 跟随，按 `polish.applied/reason` 显示绿色已润色或橙色回退原因（not_configured/provider_error/validation_failed/fabrication_detected 中英映射），默认关闭、全 token 样式、2 个 E2E 守护。

设计初衷（触发条件）：A 档上线后用户明确反馈"模板措辞太硬、需要更自然表达"，再开启 env 配置。硬约束（已由 `resume-core/polish.ts` 纯安全层强制，测试守护）：

- LLM **只在 ResumeDraft 之后**工作，输入锁定为 ResumeDraft + posting，输出为受约束编辑（仅 summary 与 evidenceHighlights.text），经 Zod 校验，失败回退规则版。
- **不得新增/删除条目、不得新增技能与数字、不得改 evidenceRefs**；只允许改写措辞。
- **数字防臆造闸门**：模型新文本去逗号后的数字集合必须是规则版草稿全文数字集合的子集，否则判 `fabrication_detected` 整条回退。
- 润色后重跑 §6-1 no-fabrication 不变量与 ResumeDraftSchema 复校，违规则整条回退规则文本。
- 记录 provider/model/promptVersion/appliedAt 进 `provenance.polish`，保证可复现（对齐 AGENTS「LLM 输出必须结构化校验」）。


## 8. 分期落地

| 阶段 | 范围 | 量级 | 依赖 |
| --- | --- | --- | --- |
| **P-R1（规则版闭环，建议先做）✅ 已落地 2026-09-15** | shared ResumeDraft/LocalResumeFields 契约；resume-core（rank/tailor/render md+html）；CLI `jobagent resume build --profile <file|id> --job <id> [--local-fields f.json] [--format md|html|json] -o out`；全套单测 | 小（1–1.5 天） | 已有画像/岗位库/匹配，无新外部依赖 |
| **P-R2（在线消费）✅ 已落地 2026-09-16** | API `POST /resumes/build`（body: profileId+jobId+可选 local，返回 ResumeDraft；不入库）；报告页岗位卡片加"针对此岗生成简历"（island：预览 md/html、打印 PDF、local 补填表单存 localStorage）；docs/API.md §3.4；E2E（含 `?resumeJob=` 深链自动触发）。实现增补：CLI/API 共用 `fromJobMatch` 映射；storage 共享 `toEvidenceItem(s)`；修复无 evidenceRefs 弱信号技能误标 source:'profile' 的内核 bug | 中（2–3 天） | P-R1 |
| **P-R3 🟡 可闭环子项已落地 2026-09-16，余外部/缓做项** | 已做：B 档 LLM **端口 + Fake + 受约束润色安全层**（§7，`resume-core/polish.ts` 数字防臆造闸门）+ **OpenAI 兼容客户端与 env 工厂**（`packages/llm/openai-compatible-client.ts`，默认关闭）+ **API `POST /resumes/build` 可选 `polish` 接线（未配置/失败回退规则版）**；扩展面板生成（深链 CTA）；多岗位批量简历（CLI `resume batch`）；**报告页「AI 润色措辞」开关 UI（2026-09-16，item19 ②，勾选带 `polish:true`、诚实回退提示、中英 i18n + 2 E2E）**。仍缓做/外部：真实启用需用户自配 LLM env（厂商/费用由用户决定）、简历版本管理（随服务端持久化，见 deferred）、~~本地档案跨端自动互通~~（schema 统一 §5.4.1 + 自动同步 item24 均已落地 2026-09-17） | — | 触发条件见 §7/§10 |

CLI 形态说明：`--profile` 支持直接读画像 JSON 文件（离线）或本地库 profileId；`--job` 读本地 job_postings 的 jobId（storage 只读），保持"内核零 I/O、I/O 在 CLI/API 薄封装"的分层。

## 9. 与现有功能的关系

- **匹配（matchJobs/推荐 island/扩展匹配面板）**：本功能是其下游消费——先算出"哪个岗匹配、为什么匹配"，再产出"针对该岗的简历"，不重复匹配逻辑。
- **扩展一键填充**：扩展填的是 ATS 表单标准字段（来自 ExportableProfile）；本功能产出的是完整简历文档，二者互补（简历可作为扩展 cover_letter/自定义问题的素材来源，P-R3 再接线）。
- **可信定位**：简历页脚/头部保留 authenticity 徽标与证据外链，延续"GitHub 验证过的你"的差异化，不做竞品式"AI 包装"。

## 10. 决策记录（2026-09-16 拍板，原"待拍板"）

> 用户 2026-09-16「按你的建议来」确认以下默认决策；除 #4 的代码已落地外，其余维持现状即可。

1. **服务端是否持久化简历 → 决策：不持久化**。按需生成、隐私最小化；简历不入库、不记日志内容。"简历版本管理"随之缓做（见 docs/deferred-items.md，触发条件＝未来明确需要服务端存档/版本对比时再建表）。
2. **补填信息存储 → 决策：只存本机，服务端不落库**。报告页 localStorage、CLI `--local-fields` 本地 JSON、扩展 ATS 域 localStorage；两端报告页/扩展自 2026-09-16（item19 ①）起统一读写 canonical `jobagent.localProfile`，旧键 `jobagent.localResumeFields` / `jobagent.localFields` 一次性迁移后删除，详见 §5.4 与 §5.4.1。
3. **PDF 方案 → 决策：浏览器打印 CSS（`@media print`），不引入 puppeteer**。零重依赖、零服务端渲染开销；服务端出 PDF 缓做，触发条件＝出现明确的"无浏览器/服务端批量出 PDF"需求。
4. **B 档 LLM → 决策：默认关闭 + OpenAI 兼容端点自配，不锁定付费厂商**。已落地 `OpenAICompatibleClient` 与 env 工厂（§7）：未设 `LLM_API_KEY` 走纯规则版（零费用、零数据外发）；设置后支持任意 OpenAI 兼容 `/chat/completions`（OpenAI/DeepSeek/通义兼容/本地模型等），`LLM_MODEL` 必填（不替用户默认付费模型），具体型号与单价以厂商当期官方定价为准、代码不内置。请求需显式 `polish:true`，未配置或安全层拒绝一律回退规则版。
5. **简历语言 → 决策：用户手选 + 默认 locale 可配**（P-R1 已实现：`locale` 默认 `zh-CN`，可选 `en`；技能名等事实保持画像原文不翻译）。

**衍生项（单列 handoff item19）**：扩展 ATS `LocalFields` 与简历 `LocalResumeFields` 的形状/存储统一——原决策为"统一 canonical schema、各自本机存储、~~不自动同步~~"（跨 ATS 域/产品域 + 不持久化导致物理隔离，见 §5.4）。**✅ 已落地（item19 ①，2026-09-16，见 §5.4.1）**：shared `LocalProfileFields` 契约 + 两投影/旧键迁移纯函数，两端改用 `jobagent.localProfile`；**"不自动同步"这一限制亦已解除——跨端自动互通已落地（item24，2026-09-17，chrome.storage + externally_connectable，见 §5.4.1）**。


## 11. 验收（P-R1 完成标准）

- [x] shared 契约 + 单测（7）；resume-core 纯函数（15），typecheck/test/build 全绿。
- [x] §6 七类测试齐备（resume-core 15 + CLI 6），no-fabrication 不变量对夹具成立：所有 `source:profile` 条目 refs 必在输入证据 id 集合内、技能名必在画像技能集合内。
- [x] CLI 对真实本地画像 + 真实 job_postings 产出 md/html/json 三格式（bayernjf × 真实在招岗实测）：命中技能置顶、tier/fieldScores 正确、gaps 正确、无画像外内容。注：该 demo 画像未向 evidence 表导入证据行，故证据亮点按 no-fabrication 留空（单测覆盖有证据时的排序/链接）。
- [x] 全仓 `pnpm -r typecheck/test/build` 通过；docs/API.md 留到 P-R2。
- [x] handoff / docs README 登记。

### 11.1 P-R2 验收（在线消费，2026-09-16）

- [x] `POST /resumes/build` 公开只读：不触发分析、不耗采集配额；json 默认 / html / md 三 format；画像或岗位缺失返 404、请求体非法返 400（7 集成测试，内存 SQLite）。
- [x] 内核 bug 修复并守护：画像弱信号技能 `evidenceRefs` 为空时不进简历正文（简历是证据子集），画像页仍展示全集；有内核单测。
- [x] 报告页 ResumeBuilder island：岗位卡片事件触发、iframe 打印 CSS 预览、打印 / 导出 PDF、下载 Markdown、本地补填仅在 apply 时发送且只存 localStorage、suggestions/gaps 诚实提示、错误重试、请求防过期。
- [x] docs/API.md §3.4；Playwright E2E 5 用例（主链路、local 边界、错误恢复、中文、`?resumeJob=` 深链自动触发）。

### 11.2 P-R3 已落地子项验收（2026-09-16）

- [x] LLM 受约束润色安全层 `polishResume`：只允许改 summary 与 evidenceHighlights.text；长度/下标校验；**数字防臆造闸门**（新数字必须 ⊆ 规则版草稿数字池）；ResumeDraftSchema 复校；任一违例整条回退原 draft（无 polish 溯源），7 单测。
- [x] `packages/llm` 端口 + FakeLlmClient + LlmResumePolishProvider（英文强约束 system prompt、Zod strip、promptVersion `resume-polish-0.1`、temperature 0.3），5 测试。
- [x] **OpenAI 兼容客户端 + env 工厂**（§10 #4 决策落地）：`OpenAICompatibleClient` 走 `/chat/completions` + `response_format: json_object`，容忍 ```json fence、HTTP/超时/非 JSON 统一抛 `LlmResponseError`、密钥只在 Authorization 头不入错误信息；`createResumePolishProviderFromEnv` 无 `LLM_API_KEY` 返回 null（默认关闭）、有 key 缺 `LLM_MODEL` 启动报错；注入假 fetch 零网络，13 单测。
- [x] **API `POST /resumes/build` 可选 `polish`**：默认不润色（响应无 `polish` 字段，零回归）；`polish:true` 且已配置→应用并写 `provenance.polish`；未配置返 `not_configured`、模型吐新数字返 `fabrication_detected`、provider 出错返 `provider_error`，均回退规则版且不使请求失败；html/md 用最终草稿；5 集成测试。
- [x] CLI `resume batch`：显式 `--jobs`（含零命中 low 降级）或全库 top `--limit` 自动匹配，逐岗写 md/html 到 `--out-dir`，5 测试。
- [x] 扩展面板每个匹配岗位「针对此岗生成简历」深链 CTA：新开报告页 `<locale>/report/<profileId>?resumeJob=<内部 posting.id>`，普通 anchor 不附 demo 会话标识；可选 reportBase 设置（生产同域取 apiBase origin，本地跨端口可覆盖）；match-utils 4 单测 + 扩展 E2E 1 用例。
- [x] 全仓单测全绿、report E2E 5 + 扩展 E2E 8 全过、typecheck/build/check-migrations/`git diff --check` 通过。
- [x] **报告页「AI 润色措辞」开关 UI（2026-09-16，item19 ②）**：ResumeBuilder ready 面板加 checkbox（默认关）+ hint + `role=status` 状态；勾选且有目标岗位即带 `polish:true` 重新生成、下载 Markdown 跟随；applied=true 绿色已润色、applied=false 橙色回退并映射四 reason 中英文案；中英各 8 i18n key、全 `--ja-*` token、E2E 2 用例（回退/成功），真实浏览器中英回退路径复验。
- [ ] （缓做/外部，非阻塞）真实启用需用户自配 LLM env（厂商/费用用户决定）；服务端 PDF（puppeteer，触发条件见 §10 #3）；简历版本管理（随服务端持久化，见 deferred）；~~本地档案跨端自动互通~~（schema 统一 §5.4.1 + 自动同步 item24 均已落地 2026-09-17）。
- [x] **本地档案 canonical 统一（2026-09-16，item19 ①）**：shared `LocalProfileFields` + ATS 投影类型 + 投影/迁移/合并纯函数（23 单测）；报告页与扩展都存 `jobagent.localProfile`、旧键一次性迁移删除；报告页表单 period 拆 start/end；targeted-resume E2E 8/8 + 扩展 E2E 8/8 + 真实浏览器迁移/投影复验。
