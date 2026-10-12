# Handoff 历史归档 — 2026-10-12

> 本文件为冻结只读历史归档，不再追加；现行状态见 [../handoff.md](../handoff.md)。
> 归档范围：活跃待办 item149–153 已完成明细（L3 语义层 A/B/C、事件流增量摊开、求职 Agent 阶段 3 C1 LLM 读 JD）+ 2026-10-11 及更早的最近变更。item152 之前的 item94–148 明细见 [handoff-archive-2026-10-11.md](handoff-archive-2026-10-11.md)。

## §1 活跃待办明细（item149–153，均已 ✅）

153. ✅ **求职 Agent 阶段 3 · C1「LLM 读 JD 结构化提取 → MatchReport 增强」落地（默认关闭、fail-closed）**（2026-10-12；提交链 `3233fcb`(shared) → `b076a6e`(llm) → `45161c7`(agent-core) → `2af047a`(api) → `7a046e2`(report) → `19be05d`(env/API 文档)；设计见 [docs/设计-求职Agent-20261002.md](设计-求职Agent-20261002.md) §3.2/§8 开放问题 3/§10 C 表 C1）。
    - **硬边界（产品契约，不可越过）**：LLM **只提取岗位侧事实**（职责 / 必备技能 / 资历），**绝不打分、不评价候选人、不造画像事实**；匹配分 / 档位 / 理由（score/tier/reasons/fieldScores/matchedSkills/ruleVersion）**永远走纯规则引擎、逐字节不变**。
    - **契约**（`packages/shared`）：新增 `JdInsightSchema`（`.strip()`；`responsibilities` ≤10 项每项 ≤120 字、`requiredSkills` ≤15 项每项 ≤80 字、`qualifications` ≤10 项每项 ≤120 字，逐项 trim/min1）+ `type JdInsight`；`MATCH_GAP_CODES` 加 `jd_requirement_not_in_profile`（复用 `MatchGapSchema.tag` 字段放要求短语）；`MatchReportSchema` 在 `suggestedBoost` 后加**可选** `jdInsight`。旧票据 optional 解析安全，**无新迁移、无需改 `system.ts` REQUIRED_COLUMNS**。
    - **LLM 端口**（新建 `packages/llm/src/jd-extraction.ts`）：`JD_EXTRACTION_PROMPT_VERSION='jd-extract-0.1'`、`JD_DESCRIPTION_CHAR_LIMIT=6000`；接口 `JdExtractionProvider{provider,model,promptVersion,extract(title,description)}`；class `LlmJdExtractionProvider`（system prompt 含逐字句 "Do NOT assess, score, or describe the candidate" 与 "Extract ONLY facts stated in the job posting"；temperature 0.1；title 截 200、description 截 6000；`JdInsightSchema.safeParse` 失败抛 `LlmResponseError`）。`openai-compatible-client.ts` 尾新增 `createJdExtractionProviderFromEnv()`（无 `LLM_API_KEY` → null；有 key 缺 `LLM_MODEL` → 抛）。
    - **纯函数内核**（`packages/agent-core/src/match-report.ts`）：`export type JdExtractor=(title,description)=>Promise<JdInsight|null>` 与 `enhanceMatchReportWithJd(report, insight, profileSkills, maxGaps=DEFAULT_MAX_GAPS(5)): MatchReport`。语义缺口**只从 `insight.requiredSkills` 出**；responsibilities/qualifications 仅挂 `jdInsight` 供渲染「岗位要求」、不产 gap（资历/学历不是补 GitHub 证据能解决，`add_evidence_for_tag` 对它无意义）。规则缺口优先，语义缺口只填 `maxGaps - 规则 gaps.length` 个名额；用 normalizeText 与画像技能、已有缺口去重；有新增缺口时 suggestedBoost 重算为全部 gaps 映射 add_evidence_for_tag；零新增也挂 jdInsight；返回新对象（不可变），绝不改 score/tier/reasons。
    - **API 接线**：`agent-config.ts` 的 AgentConfig 加可选 `jdExtractor?`（运行时注入、不进 `loadAgentConfig` env 解析）；`agent-runner.ts` 在 `planIntents(selected,{profileSkills})` 之后、toEvidenceItems 之前逐候选增强（无 description 则 skip；extractor 抛错 try/catch 静默回落纯规则＝fail-closed）；`index.ts` 仅在非注入 deps 时按 `AGENT_JD_LLM_ENABLED ∈ {true,1}` 装配 `createJdExtractionProviderFromEnv()`。**后台 cron 无登录用户上下文，只走内置 env LLM、不走 BYOK。**
    - **前端**：`AgentWorkbench.tsx` gap 类型改两 code 联合、按 `fillTemplate(labels.match.gap[gap.code],{tag})` 渲染；workbench.astro labels 与 zh-CN/en 字典加 `workbench.match.gap.jdRequirementNotInProfile`（zh「职位描述提到要求「{tag}」，画像里还没有这条技能的记录」/en「The job description asks for "{tag}", which has no record in your profile yet」）。**未做（可选增量）**：jdInsight 的 responsibilities/qualifications「岗位要求」独立渲染板块。
    - **开关与 env**：默认 `AGENT_JD_LLM_ENABLED=false`；`.env.example` 加中文注释 + 该行；`docs/API.md` 环境变量表登记；部署执行单 E3 生产总表**不加**（默认 false 的可选开关）。**生产启用需在 Vercel 置 `AGENT_JD_LLM_ENABLED=true`（内置 `LLM_*` 已配齐）。**
    - **测试（三层）**：llm `jd-extraction.test.ts` 8 例（FakeLlmClient 断言 system/user 消息序、fromEnv 三态）；agent-core `match-report.test.ts` 尾加 describe 5 例（不改分/tier；规则缺口 tags TypeScript/React/Kubernetes + 画像技能 TypeScript + insight requiredSkills [Kubernetes, react, Rust, Go, TypeScript] → 仅补 React/Rust/Go；responsibilities/qualifications 不产 gap；maxGaps 截断；零新增也挂 jdInsight 且不改入参），共 21 例；api `agent.test.ts` 尾加 describe 2 例 + `harnessWithJd`/`scanOnce` helper（extractor 抛错→run 仍 awaiting_approval、jdInsight undefined、gaps 全 tag_not_in_profile；返回 insight→jdInsight 精确相等、gap codes 含两类、tier 仍 high），共 22 例。
    - **同批测试补强 / 核查结论（内部任务 #142–#147）**：
      - #142（A1，事件流增量展开）：生产工作台「展开时全出来」（展开态 12252px、收起按钮消失）。后端分页早已生效（item147，窗口 PAGE_LIMIT=200），缺陷只在展示层；功能修复 `c532128`（expandedCount + EVENT_EXPAND_STEP=50）。本轮补真全栈 E2E `e2e/agent/workbench-timeline-expand.spec.ts`（造 run-timeline-big + 60 事件，断言折叠 5 → 展开 53 → 再点 60 → 收起回 5），实跑 1 passed，提交 `429f82f`。
      - #143（A2，Admin LLM 目录加载占位）：功能修复 `7b57119`（pending 态误显 loadFailed，改 loading 文案）；本轮补 `AdminLlmCatalog.test.tsx`（jsdom 5 用例，pending 用永不 resolve Promise），5 passed，提交 `175f5f9`。
      - #145（B-1，BYOK 保存后自动测连接）：`ModelSettings.tsx` 抽出共享 `runValidationRequest(body)`，PUT 成功→清空 key 框→load()→空体 validate（回落刚保存的加密配置）；新增测试断言保存后恰好 1 次空体 validate，5 passed，提交 `5294c86`。
      - #146（B-2，/recruit 翻页节流）**实查判定早已满足、无新代码**：`enforceCandidatesRate` 已把 IP 滑窗（candidates 桶默认 120/h、超限 429）同时挂 `GET /candidates` 与 `/candidates/export`；唯一零节流路径是 SSR 首屏固定 `loadInitialCandidates(limit:12)`（要求登录+声明招聘方、拖不了库，重复加节流无意义）。
      - #147（B1-c，关键词搜索 + CSV 导出）**实查判定早已满足、无新代码**：`CandidateSearchQuerySchema.keyword` + `buildCandidateSearch` + 前端搜索框、`toCandidateCsv`/`exportCsv`/offset 翻页/i18n，后端前端测试均已存在。
      - #144：全量三件套回归全绿（typecheck/build/test）。
    - **工程教训（两次踩中）**：改 `packages/shared`、`packages/agent-core`、`packages/llm` 的 src 后，apps/api 与 CLI 的 vitest 运行时引用的是这些包的 **dist 旧产物**，跑测试前必须先 `pnpm --filter @jobagent/<pkg> build`，否则报 `Cannot read properties of undefined (reading 'safeParse')` 或 `expected undefined`。dist 不入库但测试依赖。

152. ✅ **修复工作台事件流「展开时一次性全摊开」**（2026-10-12，`c532128`；E2E 补于 `429f82f`）。后端分页（item147，窗口 PAGE_LIMIT=200 + 「展开更早」）早已生效，真实缺陷只在展示层：折叠态只显示最新 5 条，但点「展开」直接把整窗 200 条全部摊平（生产实测展开态内容高约 12252px），且摊平后收起按钮从 DOM 消失、无法收回。改为增量展开：折叠显示最新 5 条 → 每次「展开更多」追加 EVENT_EXPAND_STEP=50 条（仍按时间升序、游标分页不变）→ 未到窗口上限保留「展开更早」服务端分页、到顶显示「已到最早」→ 只要处于展开态就常驻「收起」按钮（折叠回最新 5 条）。补 i18n（workbench.timeline.expandMore / collapse / expandedAll，中英各 3 key）与组件单测（折叠 5 / 展开 55 / 再点 105 / 到顶文案 / 收起回 5 / 窗口满时不再出现服务端「展开更早」），report vitest 全绿。**真全栈 E2E 已补**（`workbench-timeline-expand.spec.ts`，`429f82f`，1 passed）。

149. ✅ **L3-A 不 clone 规则版语义层**（2026-10-11；设计 `docs/design-semantic-layer-20261011.md`）。新增 `packages/semantic-source`（复用 `createOctokit`：listRepos sort=pushed 默认 5 仓 → getTree recursive 截断 2000 blob → README raw ≤16KB → 关键文件白名单 package.json/pyproject.toml/go.mod/Cargo.toml/requirements.txt/Dockerfile + 第一条 workflow ≤7 个各 ≤16KB；单仓失败降级 missing、REST 预算默认 60 超限硬失败不降级）与纯函数 `packages/semantic-core`（`analyzeSemantic`：成熟度五布尔 + fileCount + starBand、techStack 四生态解析、repoKind 六档、domainHints 词边界匹配；缺失传透不冒充零；独立 `SEMANTIC_RULE_VERSION='0.1'`）；CLI `semantic analyze <user> [--repos N] [--out] [--format json|markdown]`。全程不 clone、不读 LLM。

150. ✅ **L3-B LLM 语义摘要 provider**（2026-10-11）：`packages/llm/semantic.ts`（`SEMANTIC_PROMPT_VERSION='semantic-0.1'`，Zod `LlmSemanticOutputSchema`，温度 0.2，只基于输入 JSON、不评价候选人）+ `createSemanticProviderFromEnv`（无 key→null）；CLI `semantic analyze --llm` 经 LlmClient 对规则版结果生成摘要，**fail-closed**（任何 LLM 失败只回退 llmSummary 并 warn、不整命令失败，绝不编造）；llm 6 例 + CLI 7 例测试，零网络。

151. ✅ **L3-C 语义并入主画像**（2026-10-11）：主画像 `RULE_VERSION 0.8→0.9`，`assembleProfile` 透传 `options.semantic` 装配 semantic 节；CLI `analyze <user> --semantic [--llm]` 端到端（collectSemantic→analyzeSemantic→可选 attachLlmSummary，任一步失败 warn 后画像无 semantic 节、不整命令失败）；报告页新增「语义洞察」板块（成熟度五信号/techStack/domainHints/repoKind/llmSummary/缺失标注，TOC 同步，i18n 21 个 `report.semantic.*` key 中英同构）；API `formatProfileForViewer` 公开透传 semantic（anonymous 可见，新增测试钉住）。**L3 全程不 clone 仓库**（守 L2 红线）。

## §2 滚出主文件的「最近变更」（2026-10-11 及更早，按时间倒序）

- 2026-10-11：B1 生产内置目录整体替换为 agnes-3.0-flash（`llm_catalog_models`，凭证仍 env only）；Admin 面板「加载目录失败」误报修复（pending 态 loading 占位，`7b57119`）。
- 2026-10-11：L3-B（`semantic analyze --llm`，fail-closed）与 L3-C（语义并入主画像 + 报告页板块 + API 透传）落地。
- 2026-10-11：L3-A 规则版语义层（semantic-source + semantic-core，不 clone，SEMANTIC_RULE_VERSION 0.1，主画像 RULE_VERSION 0.9）。
- 2026-10-11：A1/B1/B2 收口——Admin 加载占位、分段备份脚本、/candidates 节流核查等。
- 2026-10-11：BYOK 三项修复（测试连接死按钮、求职信失败不落日志、TimeoutError 未进超时分支），提交 `045df3f`/`67b3f23`/`b2e20d2`。
- 2026-10-11：digest 发信改双通道（CF EMAIL binding 优先 → Resend API 回落；Workers Free 不支持 Email Sending 是首跑无心跳根因）；用户自建 Resend 账号/域验证、确认收到验证邮件。
- 2026-10-11：工作台事件流跑满 200 条上限界面冻住 + 每条自迁移平铺，折叠与分页落地（item146/147，PAGE_LIMIT=200）。
- 2026-10-10：Cron 失败自动告警（watch-heartbeat stale 翻转边沿 Web Push + digest-tick 每日兜底），闭环 deferred「Cron Worker 失败信号没有读者」；VAPID keys 配生产。
