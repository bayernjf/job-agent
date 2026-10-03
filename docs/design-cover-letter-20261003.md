# LLM 求职信生成（A 档）设计

> 状态：现行 · 2026-10-03 · 对应 handoff item101（A：LLM 求职信生成）
> 范围：`packages/llm`（生成器）、`apps/api`（端点）、`apps/report`（报告页入口）、`docs/API.md`

## 1. 背景与定位

简历（`/resumes/build`）回答"我是谁、能做什么"，求职信回答"我为什么申请这份工作"。求职信是技术应聘的标配下一步：画像 + 岗位定向简历已就绪，LLM（Agnès 网关，本地 `.env` 已配 `agnes-2.5-flash`）刚解锁，正好与求职 Agent 阶段 2（半自动投递）衔接——阶段 2 的"自动填充申请"需要一封可用信，本功能先提供人工复核版。

## 2. 与 resume-polish 的本质差异 → 防臆造三层

| | resume-polish（B 档） | cover-letter（A 档） |
| --- | --- | --- |
| 性质 | 改措辞（原文已存在） | **生成性 prose（全新文本）** |
| 防臆造闸 | resume-core 契约级：数字/技能注入回滚 | **无契约级闸可挂**（新文本不与原文对齐） |
| 失败策略 | 回退规则版 | **如实报错，不降级为"伪求职信"** |

因此防臆造依赖三层：

1. **prompt 硬约束**：只允许引用简历草稿/岗位中已出现的事实；严禁新增数字/日期/公司/产品/技能名；禁止"我缺乏…"式自贬；禁 superlatives；en ≤220 词 / zh ≤380 字。
2. **输出 schema**（Zod）：`subject? ≤120`、`body 10..4000`，`.strip()` 剥离未知字段；非法整体抛 `LlmResponseError`。
3. **用户复核**：产物是用户主动请求、人工过目后再使用；UI 明示"请人工复核后再提交"。

版本：`COVER_LETTER_PROMPT_VERSION='cover-letter-0.1'`，temperature `0.4`（生成性文本略高于 polish 的 0.3）。任何措辞/结构变更必须 bump。

## 3. 接口形状

```ts
// packages/llm/src/cover-letter.ts
interface CoverLetterOutput { subject?: string; body: string }
interface CoverLetterProvider {
  readonly provider: string; readonly model: string; readonly promptVersion: string;
  generate(input: { draft: ResumeDraft; posting: JobPosting; locale: ResumeLocale }): Promise<CoverLetterOutput>;
}
```

- `LlmCoverLetterProvider`：复用通用 `LlmClient`；`systemPrompt(locale)` 为硬约束，`userPrompt` 传 `job{title, company, description 切片 2500}` + `candidate{headline, summary, evidenceHighlights.text, skills(=matchedSkills+otherSkills 的 .text)}`。
- `createCoverLetterProviderFromEnv`：与 polish 同款默认关闭——无 `LLM_API_KEY` → null；有 key 缺 `LLM_MODEL` → 抛错；缺 `LLM_BASE_URL` → 官方 OpenAI 兼容端点。

## 4. API 端点 `POST /resumes/cover-letter`

- 请求：`{ profileId, jobId | posting（二选一）, locale?, local? }`——与 `/resumes/build` 共用画像/岗位/匹配解析；`buildResume` 先装配规则版草稿，草稿 + 岗位喂 LLM。
- 鉴权：**仅登录 user**（LLM 付费，参照 `polish:true` 的 403 `AUTH_REQUIRED` 模式）。
- 响应：`200 { subject?, body, provenance{provider, model, promptVersion} }`；`503 LLM_NOT_CONFIGURED`（未配置）；`502 LLM_FAILED + reason`（调用失败/schema 未过）；产物不入库、不记日志。
- **无规则版回退**——与"禁止输出看似完整报告"口径一致。

## 5. 前端入口（报告页 ResumeBuilder）

`status==='ready'` 且草稿/岗位就绪时，resume-panel 内 polish 区下方新增"生成求职信"按钮：点击 → POST 端点 → 只读 textarea 展示 `subject`+`body`，提供**复制**与**下载 .md**；错误按码显示 `AUTH_REQUIRED` / `LLM_NOT_CONFIGURED` / 通用失败 + 重试。文案走 `t()`（`report.resume.coverLetter*`，中英 key 对，一致性测试守护）。

## 6. 决策记录（本档为已拍板，不写"待办"）

- **岗位定向生成**（profile draft + target posting 为输入）：与阶段 2 衔接，工作台就绪时直接复用；不另做"通用求职信"（无目标岗位的信价值低且更易臆造）。
- **仅登录 user 可用**：LLM 付费能力，同 polish。
- **本地补填 `local` 进草稿**：姓名/联系方式/工作经历是求职信核心素材，且只存浏览器本机、不入库。
- 用户需拍板（代码已按推荐闭环，不阻塞）：J7 生产 Vercel 是否配 `LLM_*`（本地 `.env` 已配 agnes-2.5-flash）。
