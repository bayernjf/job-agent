# 方案：C 端优先重排（把产品做成"能替我拿下 offer"的东西）

- 日期：2026-09-25
- 状态：**已拍板（2026-09-25），未实施**。用户对决策 [#18](待拍板决策清单-20260910.md) 与 [#17](待拍板决策清单-20260910.md) 的全部待勾子问题指示"都按照你建议的来"——三个子问题按助手建议落地：**Q1 = A+B**（扩 AI/Agent 目录 + GitHub topics 直取归一，LLM 辅助打标缓做）、**Q2 = 融合画像按任一源命中即可认领并记录实走平台**、**Q3 = 投递/面试隐私修复提前，与 C-A 并行**。实施任务清单见本文 §10。
- 定位：这不是新功能清单，是**按"能不能替一个真实求职者走完一轮求职"重排现有能力**的判断书。所有断言带 `file:line`，都可实查。
- 关联：[PRD.md](PRD.md) §3.1/§3.3/§4.4、[design-recruiter-roles-20260925.md](design-recruiter-roles-20260925.md)（B 端第一期，本方案把它往后排）、[design-targeted-resume-20260915.md](design-targeted-resume-20260915.md)、[design-auth-gating-20260919.md](design-auth-gating-20260919.md)、[deferred-items.md](deferred-items.md)

## 1. 判据：什么叫"能帮我拿下 offer"

一个求职者用这个产品，必须依次走通六步，任何一步断掉都不算成：

1. **说得清我** —— 画像能表达我的真实能力（含 AI/Agent 这类新能力，不是只有"Python/data-ml"）；
2. **指得清路** —— 告我现在缺什么、改了能多拿面试；
3. **交得出东西** —— 一份针对具体岗位、能直接投出去的简历，和一份能进面试的房间；
4. **守得住隐私** —— 我的投递与面试数据只有我看得到；
5. **管得住管道** —— 我投了 30 家、约了 4 场面试、2 个 offer，在一个地方看得见；
6. **找得到岗** —— 推荐的岗位是真的、新鲜的、和我能力匹配的、且跟我已投的不重复。

**"突出核心功能"的过滤器（每个新表面都要过这条）**：核心差异化是**可验证证据链**（"这条结论来自你真做过的 commit/PR/Issue"），不是简历排版。任何改动若不能强化"这条来自你真实做过的事"，就不做。按这条过滤器，第 1/2/3 步是核心，第 5 步是承载，第 4/6 步是前置卫生。

## 2. 现状：六步里断在哪（逐条实查）

### 2.1 第 1 步断在词典上——最致命

- 技能目录 **62 条**（`packages/analyzer-core/src/skills-catalog.ts`），`agent|rag|langchain|prompt|mcp|vector|openai|anthropic` 全部 **0 命中**；唯一的 AI 相关是 `:85` 一条 `data-ml`，别名 `'data','machine learning','ml','llm','ai','pytorch','tensorflow'`，`kind:'domain'`、置信度封顶 0.7。
- **没有自由文本逃逸口**：framework/domain 标签的唯一生产者是 `computeCatalogTags()`（`packages/analyzer-core/src/skills.ts:94-143`），它**只遍历目录**。目录里没有的词，画像里就不可能出现。
- 后果：一个做 LLM Agent / RAG / eval harness / MCP 的开发者，画像会被压成 `Python` + `data-ml`。**这正好是 2026 年技术岗最主力的需求面**。用户自己就是这条赛道的求职者 —— 产品今天说不清用户的能力。
- 连带：岗位匹配只喂技能名（`apps/api/src/index.ts:1117`）+ 整词正则（title×3/tags×2/description×1，`packages/job-source/src/match/job-match.ts:25-29,78-82`），所以画像侧缺词 = 推荐侧必然零命中。

### 2.2 第 2 步是空的：契约有、生产者零

- `AbilityProfile.improvementSuggestions` 在 `packages/shared/src/index.ts:179-187` 定义齐全（suggestion/why/evidenceRefs），全仓**无任何生产者**（grep 只命中 schema 与 `dist/`）。
- 讽刺的是内核**已经知道答案**：`narrow_activity_scope`（单仓/事件面窄）、`self_pr_ratio`（外部协作少）、`activity.metrics`（`totalStars`/`mergedPullRequests`/`commitRepoCount`，`packages/analyzer-core/src/activity.ts:36-53`）都在算，只是从不翻成"你该做什么"。
- 所以"下一步动作"区块（PRD F4/F8 的 C 端增值承诺）在 UI 上不存在。这条是**核心功能里最该有、且成本最低的一块**。

### 2.3 第 3 步交付物有硬缺陷

| 缺陷 | 证据 | 后果 |
| --- | --- | --- |
| ~~下载 `.md` 丢用户填的一切~~ ✅ T11 已修 | `ResumeBuilder.tsx:275-285` 的 md 请求体**不带 `local`**，而同一组件的 html 请求带（`:188-198`） | 投出去的简历没有姓名/邮箱/教育/工作经历 —— 直接不可用 |
| 内部批注印进交付物 | `render/markdown.ts:91-95`、`html.ts:159-165`：`draft.suggestions` 被渲染成交付简历里的一节 notes（每条 `- [missing_skill] …`、"缺少联系方式（邮箱）"） | 招聘方看到的是"这人简历里带自我诊断" |
| ~~中文简历混英文、且主体口径写死~~ ✅ T07 已修 | headline 原在 `packages/analyzer-core/src/summary.ts` 硬编码英文，**无 platform 分支**（Gitee 画像也写 "GitHub developer"），`tailor.ts:85` 原样贴入 | 双语产品口径破口 + 事实性错误 |
| 没有"项目"概念 | 一条经历 = `EvidenceItem.claim` 原文（如 `Repository o/n (TypeScript): 3 stars / 1 forks, last pushed …`，`packages/github-source/src/evidence.ts:33,46`） | 简历是关键词 + 仓库元数据，没有所有权/规模/结果 |
| 数字全被丢掉 | `activity.metrics`/`cadenceSummary` 在报告页渲染（`report/[profileId].astro:412-441`）却**不进任何简历或面试包**；`PR.additions/deletions/changedFiles`（`analyzer-core/src/input.ts:66-68`）采集后从不使用 | 招聘方 30 秒扫描看的就是量化行，我们一个字都不给 |
| 薄画像也出"完整"简历 | `buildResume`/`/resumes/build` 从不读 `authenticity.status`，`insufficient_data` 不拦 | 违反 AGENTS 与 PRD NFR-6"禁止输出看似完整的报告" |

诚实层是真的强（`ResumeEntrySchema.superRefine` 拒空 `evidenceRefs` + 每次 build 末尾 `ResumeDraftSchema.parse` 抛错，`packages/shared/src/index.ts:806-815`、`tailor.ts:241`；LLM 润色有数字子集闸与整体回滚，`resume-core/src/polish.ts:51-58,101-156`）。**问题不在造假风险，在表达力与卫生。**

### 2.4 第 4 步：求职数据是公开的

- `GET/POST /profiles/:id/applications` 与 `PATCH /applications/:id` **无身份校验**（`apps/api/src/index.ts:1429/1439/1469`），而 `profileId` 出现在每一条分享链接里。任何人可读、可注入、可改你的投递管道（含改成 `offer`）。
- 而且**报告页就是默认对匿名访客挂载这张表**：挂载条件是"非招聘方视角"（`[profileId].astro:522-525` 的 `!isRecruiter`），不是"是本人"。所以把报告链接发给任何人，等于同时开放自己求职管道的读与写。
- `GET /candidates` 匿名可分页遍历整个画像库（`:1384`）。
- 这是 [design-recruiter-roles-20260925.md](design-recruiter-roles-20260925.md) §1.2 的三个洞，此前定性为"上线后第一迭代"。**C 端优先意味着这条定性要改**：属于求职者自己的那一半（投递归属）要提前，招聘方声明那一半可以留后（§4）。

### 2.5 第 5 步：管道今天不存在

- 没有"我的"任何形态：`profiles.listBySubject`（`packages/storage/src/repositories/profiles.ts:16`）**无任何路由调用**；`AccountMenu.tsx:19` 接收 `claimedProfileId` 然后从不渲染；导航无"我的报告"入口。用户离开一次链接就回不到自己的画像。
- 投递记录全部 `origin='manual'`、`jobId=null`：tracker 提交体不带这两个字段（`ApplicationTracker.tsx:157-163`），推荐位与投递位**从不互相读**（`:1110-1178`），零去重。
- 面试计划表求职者用不了：它只挂在 `/recruit`（`recruit.astro:94`），候选人下拉取 `GET /candidates?limit=100`（`InterviewPlanner.tsx:159,363`）——**你没进前 100 名候选人就根本建不出面试行**；文案是招聘方口吻（"为候选人安排面试"），求职者用它等于给自己打分。
- 最完整的那份画像永不能标"本人已验证"：`platform=all` 时 `ClaimProfile` 直接隐藏（`[profileId].astro:152`），认领校验要求 `subjectPlatform === principal.platform`（`api/index.ts:1088`）。

### 2.6 第 6 步：供给侧今天不够真

- 5 个适配器（`job-source/src/adapters/registry.ts:60-85`），种子 **8 Greenhouse + 9 Lever = 17 家自选公司**；实测入库量 ~3.9k 条里 ~3.4k 来自这 17 家 —— **是自选清单，不是市场**。
- AI 岗主战场缺位：YC/Wellfound 反爬暂缓、无 LinkedIn、`weworkremotely` 枚举有值无适配器（`packages/shared/src/index.ts:293`）。
- 候选池只取**最新 500 行**再打分（`api/index.ts:1143-1156`，`MAX_LIMIT=500`），推荐无 offset（不能翻页）、无关键词、UI 只发 `limit=10`（`JobRecommendations.tsx:160`）。
- 跨源重复**只标记不合并**（`job-source/src/normalize/dedupe-key.ts:6-7`）→ 同一岗位多次出现。
- 时效性是死的：日更 workflow 整个 gated 在 `DATABASE_URL` secret 上（`.github/workflows/jobs-sync.yml:66-86,98-100`），**生产未部署 → 定时同步静默跳过**；`markStale` 无 source 参数（`storage/src/repositories/job-posting.ts:47`），单源同步会误停其他源，靠 `--stale-days 35` 绕过（`jobs-sync.yml:118`）。
- `JobPosting` 无签证/工作许可字段，`location` 是原始自由文本、检索无地理位置过滤。**对一个需要工签的求职者，这是硬缺失。**

## 3. 分期（每期一个"用户视角完成定义"）

顺序按"缺了它我自己都用不了"排，不按工程量排。

### C-A 让它说得出我是谁（核心，最先）

1. **技能目录补 AI/Agent 层**：新增 framework 级条目（agent / llm-agent / rag / prompt-engineering / eval-harness / vector-db / model-serving / mcp / langchain / llamaindex / instructor 等），沿用既有词边界与别名归一机制（`skills-catalog.ts` 结构 + `skills.ts` 编译正则），并**为每个新条目定义可核验证据来源**（repo topics 优先，仓名/描述次之，commit/PR 标题再次），避免把口号当技能。
2. **给目录加"语言无关"的兜底生产者**（讨论项 §7-Q1）：仅靠目录 = 一个词没收录就永远表达不出；候选方案是"topics 直取 + 归一化"，但必须保留可核验性。
3. **PR diff 规模进证据**：`additions/deletions/changedFiles` 已在 `AnalyzerInput`（`input.ts:66-68`）却从不使用 → 产出"我在 X 仓库合了 N 行、跨 M 个文件的 PR"这类可复核量化行。
4. **修双语 headline** ✅ 已落地（T07）：模板移到 `packages/shared` 的 `composeHeadline`，平台名按画像主体取，读者语言现拼；不改分析口径、只改文案生成。

**完成定义**：用户本人账号跑一次分析，`skillTags` 里出现与其真实仓库/PR 对得上的 Agent/RAG/eval 类标签且每条挂可点开的证据；26 个标注账号双向回归零误伤（既有校准惯例，`likely_authentic` 不被降级）。

### C-B 让它告诉你下一步做什么

5. **实现 `improvementSuggestions` 生产者**（内核 → 建议），规则化、可解释、每条挂 `evidenceRefs`：由 `narrow_activity_scope` / `self_pr_ratio` / 外部 merged PR 缺失 / 无 issue→PR 闭环 / 长期断续 等既有信号映射成"动作 + 预期效果"，**不得引入画像里没有的事实**。
6. **报告页新增"下一步动作"区块**（中英双语、token 样式、证据可回溯），并把"投了之后没回音"这类结果反馈（见 C-D 的结果标签）作为建议的输入。

**完成定义**：任取 5 份真实画像，产出 3–5 条**可执行且可核验**的建议（不是"多参与开源"这种废话），每条能点开看到支撑它的那条 commit/PR。

### C-C 让它交得出能用的东西

7. 修 **md 下载丢 `local`**（`ResumeBuilder.tsx:275-285` 与 html 请求对齐）。
8. **内部批注/匹配分/版本脚注从交付物里移出**，只留在产品界面；交付物 = 招聘方视角的干净文档。
9. **引入"项目条目"抽象**：一条经历 = 主体 + 动作 + 规模 + 结果 + 证据链接，全部由画像与 PR 元数据派生，继续受 no-fabrication 闸约束。
10. **量化行进简历与面试包**（`activity.metrics` → resume/kit）。
11. **薄画像/被标可疑的画像不出"完整简历"**：`buildResume` 读 `authenticity.status`，`insufficient_data`/`suspicious` 时显式降级并说明缺什么（对齐 NFR-6）。
12. 面试包升级：从"5 道通用题干"→ **按岗位定向的准备单**（该岗位命中技能 + 对应证据 + 你被问到什么 + 你该反问什么），仍纯规则、仍可回溯。

**完成定义**：用户能对**一个真实目标岗位**产出中英各一份、含联系方式与量化、无内部批注、可直接投递的简历 + 一份面试准备单。

### C-D 让它守得住隐私、管得住管道、找得到岗

13. **投递与面试数据收归本人**：`applications` 补可空 `created_by_account_id`（有主行非主不可改，404 不泄露存在）+ 投递读侧按身份过滤 —— 这一条从 [design-recruiter-roles-20260925.md](design-recruiter-roles-20260925.md) 的 F11 **提前**，理由：它保护的是 C 端用户自己的数据，不是 B 端便利。
14. **"我的求职"页**（一个登录用户的 home）：我的画像列表（接上 `listBySubject`）+ 我保存/投递的岗位 + 我的面试 + 我的简历。这是产品第一次有"账号感"。
15. **求职者视角的面试管道**：复用 012 `interviews` 表与行级归属（技术上已可用，见 §2.5），**换挂载点与文案**（挂到"我的求职"，标题改成自己的管道），并把 `applicationId` 真接上（现在 API 支持推进投递状态、UI 从不传，`api/index.ts:1501-1512` vs `InterviewPlanner.tsx:232-243`）。
16. **融合画像可认领**（`platform=all` 的认领语义单独定义，见 §7-Q2）。
17. **推荐去重与翻页**：推荐结果读 `applications` 剔除已保存/已投；加 offset 与关键词；跨源同岗位合并（今天只标记）。
18. **岗位供给**：见 §5 —— 明确它不在 C 端代码里，而在"部署 + 数据源"上。

**完成定义**：用户在这一个页面里看得见"我投了哪些、到哪一步、下一场面试什么时候"，且未登录者什么都看不到。

## 4. 与 #17（B 端角色）的关系：改序，不改结论

C 端优先**不是**推翻 [design-recruiter-roles-20260925.md](design-recruiter-roles-20260925.md)，而是把它的两半拆开：

| #17 的内容 | 原定性 | 本方案 | 理由 |
| --- | --- | --- | --- |
| F11 投递记录归属（保护求职者自己的数据） | 上线后第一迭代 | **提前进 C-D** | 受益人是 C 端用户本人 |
| F10 招聘方声明 + `/candidates` 加闸 | 上线后第一迭代 | **维持原序，排在 C-A~C-C 之后** | 它是 B 端卫生，不影响用户自己走完求职 |
| 组织 / 席位 / 计费 | 缓做带触发条件 | **不动** | 已挂 deferred |

一个副作用要写明：#17 的 `recruiter_declared_at` 与 `requireRecruiter` 是 F10/F11 共同的技术底座。F11 先做时会走"仅登录、不分角色"的临时形态（等价于原 #17 的选项 C），日后补 F10 时**不回头改 F11 的归属列**，只把闸的判据从 `user` 换成 `user && declared`。这是刻意的顺序约束，写进实现要求。

## 5. 一个 C 端代码救不了的阻塞

**岗位库是死的**：日更 workflow gated 在未配置的 `DATABASE_URL` secret 上（`.github/workflows/jobs-sync.yml:66-86`），而形态 C 尚未部署。任何 C 端 UI 改进都无法让"推荐岗位"变真。

因此第 6 步的真实前置是**部署 + 扩源**，不是代码：

- **前置 A**：P0-3 控制台部署（Runbook/执行单已备齐，只待人工操作）→ Actions secret 配好 → 岗位日更真的跑起来。
- **前置 B**：AI 岗供给扩源。已实测被拒的路要重开一次判断：YC（406 + HTML 内嵌）、Wellfound（Cloudflare turnstile）、WWR（字段太薄）。可选路径按成本排序：① 补 Greenhouse/Lever 种子（**纯配置**，加 30–50 家真实在招 AI 公司即可入库，复用现适配器）；② `weworkremotely` 补适配器（枚举已在，成本最低）；③ LinkedIn / 国内板块（反爬与合规风险，需单独拍板）。
- **建议**：先做 ①，因为它今天就能把"岗位是不是真的"从 17 家变成 60+ 家，而不动一行匹配逻辑。

## 6. 明确不做（防止"尽可能全"变成发散）

- 不做 L2 clone / 代码语义分析（AGENTS 硬约束，PRD R3）。
- 不做自动投递、后台批量投递（PRD §2.2 非目标；决策 #15 边界）。
- 不做简历花模板 / 设计系统扩张 / 服务端 PDF（已决策浏览器打印）。
- 不把 LLM 引入分析内核的结论生产（可复现性优先；润色仍是受约束后处理）。
- 不做 B 端组织层、岗位反向检索（企业找人的能力今天已经够了）。
- **不在 C-A~C-C 期间碰任何新的招聘方表面**。

## 7. 拍板记录（决策 #18，2026-09-25）

用户指示"都按照你建议的来"，三个子问题按助手建议定：

1. **技能表达不只靠目录** → **A + B 同做**：先扩 AI/Agent 目录条目（可控、零风险），再加 GitHub topics 直取归一的兜底生产者（覆盖未收录能力，仍可回溯证据）；**LLM 辅助打标缓做**（破可复现性，且内核结论必须版本化）。
2. **融合画像（`platform=all`）认领** → **任一源命中即可认领**，并在认领记录里存"实际走的哪个平台身份"。不引入新的账号-画像多对多表。
3. **投递/面试数据隐私** → **是，抢在 C-A 之前与 C-A 并行做**（它保护的是使用者自己的数据）。

同时接受 §5 的判断：**扩岗位种子清单（纯配置）+ 部署优先于再写 C 端 UI**。

## 8. 落地与验证约定

- 拆原子提交沿用仓库惯例：`shared` 契约 → `db` 迁移 → `storage` → `api` → `report` → `docs`，功能/文档/测试不混提。
- 每期交付门禁：`pnpm -r typecheck`、`pnpm -r test`、`pnpm -r build`、`bash tools/check-migrations.sh`、`git diff --check`；C-C/C-D 有 UI，必须跑 `pnpm e2e`（报告页）与相关扩展 E2E。
- **C-A 的硬门禁是双向零误伤**：技能目录扩张必须重跑 26 账号（GitHub）+ 9 账号（Gitee）真实回归，`likely_authentic` 一个不许掉级；新标签的证据引用全部命中 `validRefs` 过滤（`analyzer-core/src/signals.ts:37-40`、`skills.ts:151`）。
- 每条新接口同步 `docs/API.md`（`api-doc-consistency` 守护）；新增 env 同步四处（`env-doc-consistency`）；新文档进 handoff 文档索引与本导航表。

## 9. 推进任务清单（#17/#18 拍板后，2026-09-25）

粒度按"一个原子提交一件事"切（AGENTS 提交规范），每条带**完成判据**与**依赖**。标 🔒 的是需用户本人操作的外部/控制台动作。

### 批次 0 · 隐私（#18-Q3 提前，与批次 1 并行，无相互依赖）——**✅ 已落地 2026-09-25（handoff item61）**

**落地时对规则做了一处收紧**：投递隐私的判据取**画像认领状态**（"认领即隐私开关"），而不是"调用者是否登录"。未认领画像没有可授权的主体、其报告按决策 #1-A 本就公开，因此匿名求职链路（PRD F11 验收 4）逐字保留；一旦本人认领，读与写都只认那个 platform+login。这样 §7 原来标记的"T03b 与 PRD F11 验收 4 冲突"被消解——两条同时成立，不需要谁推翻谁。

| # | 任务 | 完成判据 | 落点 |
| --- | --- | --- | --- |
| ✅ T01 | 迁移 013：`applications.created_by_account_id`（两侧对齐） | `bash tools/check-migrations.sh` 13 对 0 warning；`./scripts/migrate-down` 能真回滚该列 | `db/migrations/{sqlite,postgres}` |
| ✅ T02 | storage：insert 落归属、update 加"要求归属匹配"能力（双实现，裸 SQL 不出仓储层） | 就近单测含"他人改不动、无主行仍可改"两分支 | `packages/storage/src/{sqlite,postgres}/applications-repo.ts` |
| ✅ T03 | api：POST 登录时写本人 id；PATCH 非主返回 **404**（不泄露存在，对齐 `/interviews`） | 植入"换身份改他人行"探针必红；`docs/API.md` §3.6 同步 | `apps/api/src/index.ts:1439/1469` |
| ✅ T03b | 投递表**只对本人出现**：报告页当前是"非招聘方视角就挂载 tracker"（`[profileId].astro:522-525` 的条件是 `!isRecruiter`），等于任何拿到报告链接的匿名访客都能读能写这份求职管道。改成"仅登录且为该画像本人（或画像无主）才挂载"，API 的 `GET /profiles/:id/applications` 同步按身份过滤 | 未登录访问他人报告时投递区块完全不出现（不是隐藏按钮）；本人访问仍正常；`pnpm e2e` 两种身份各一条。**⚠️ 采纳本条会推翻 PRD F11 验收 4**（"投递追踪的既有匿名 E2E 不回归为需要登录"），二者只能留一个：建议改 PRD 那句为"未登录可浏览报告，但投递区块需登录才出现"——对真实求职者，"链接泄露＝求职管道泄露"比匿名可用性重要。**此处需用户明确点头，不由实现者自行取舍** | T03 |

### 批次 1 · C-A 说得清我（决定"产品能不能替你说话"）——**T04/T05/T06/T07/T08 ✅ 全部落地（2026-09-25），0.4 双向零误伤回归通过**

| # | 任务 | 完成判据 | 依赖 |
| --- | --- | --- | --- |
| ✅ T04 | 技能目录补 AI/Agent 层：framework 条目 + 别名 + 词边界（`agent`、`llm-agent`、`rag`、`prompt`、`eval`、`mcp`、`vector-search`、`model-serving` 等） | 每条新词各有正向 + **反例**测试（防 `user agent` / `agency` 误命中）；analyzer 套件绿 | — |
| ✅ T05 | GitHub topics 直取归一兜底生产者（Q1-B） | 目录未收录但 topics 明确的能力能出标签且挂真证据；未知 topics 被噪声表挡住 | T04 |
| ✅ T06 | PR diff 规模入证据（`additions`/`deletions`/`changedFiles` 已在 `AnalyzerInput` 却从未使用） | 产出"在 X 合了 N 行 / M 文件的 PR"这类可复核量化证据 | — |
| ✅ T07 | headline 平台化 + 双语：模板与取法收敛到 `shared` 的 `composeHeadline(facts, locale)`／`headlineFactsFromProfile(profile)`，报告页、简历 header、面试包三处按读者语言现拼；分析内核只把**平台正确**的英文原句写进快照 | Gitee 主体不再被写成 GitHub（单测 + E2E 各钉一条）；中英同一套事实同一句模板；不加字段、不加迁移，旧快照照旧解析 | — |
| ✅ T08 | 规则版本 0.3 → **0.4**（`rules.ts`）+ 双向零误伤回归（**2026-09-25 实跑通过**） | GitHub 26/26 采集成功：22 正样本 0 误报、4 负样本 0 漏报；Gitee 可解析 9 账号与基线逐条一致；3 处漂移经"分级器与采集器自 `be07ab6` 起逐字节未变"证明为线上数据变化，非规则回归 | T04–T07 |

> T07 落地时顺手拆掉两颗连带雷：① headline 原自带 `${login} — ` 前缀，与简历 `# {name} — {headline}` 模板相加会渲染成 **"alice — alice — …"**，故 `HeadlineFacts` 不含 login（姓名/账号由各处标题自己带）；② 快照原取 `input.repos[0].primaryLanguage`（＝**采集顺序第一个仓**的语言，不是主力语言），现与渲染侧统一取 `skillTags` 里第一个 language 标签。
>
> **刻意仍留数据层英文的表面**：`packages/storage/src/entities/candidate.ts:80`（人才库检索索引，该层无读者语言）、`toExportableProfile` 的 `headline` 与扩展填充（ATS 的 headline 字段本就常填英文）。要中英随扩展界面语言，得给 `ExportableProfile` 或填充层加语言入参——本批不做（半成品只会多一套要维护的契约），需要时按 T 编号新开一条。

### 批次 2 · C-B 指得清路

| # | 任务 | 完成判据 | 依赖 |
| --- | --- | --- | --- |
| T09 | `improvementSuggestions` **生产者**（契约已在 `shared/src/index.ts:179-187`，全仓零生产者） | 纯函数、规则版本化；每条挂 `evidenceRefs`；任取 5 份真实画像出 3–5 条**可执行可核验**建议（禁"多参与开源"这类无证据套话） | T08 |
| T10 | 报告页"下一步动作"区块 | 中英 key 同构、全用 `--ja-*` token、证据可点开；`pnpm e2e` 补用例 | T09 |

### 批次 3 · C-C 交得出东西

| # | 任务 | 完成判据 | 依赖 |
| --- | --- | --- | --- |
| ✅ T11 | 修简历 md 下载丢 `local`（`ResumeBuilder.tsx:275-285` 与 `:188-198` 对齐） | E2E 断言下载的 md 含姓名/邮箱 —— **修完这条才有"能直接投"的简历** | — |
| T12 | 交付物卫生：内部批注（`markdown.ts:91-95`、`html.ts:159-165`）、匹配分、provenance 脚注移出交付物，只留产品界面 | 导出的 md/html 里不含 `[missing_skill]`、"缺少联系方式"、分数框 | — |
| T13 | "项目条目"抽象：主体 + 动作 + 规模 + 结果 + 证据链接（吃 T06 的 diff 数据） | 仍受 no-fabrication 闸约束（`shared/src/index.ts:806-815`），空证据必抛 | T06, T12 |
| T14 | 量化行进简历与面试包（`activity.metrics` 今天只在报告页渲染，进不了任何交付物） | 简历出现由画像直取的合并 PR 数 / 跨仓广度 / 持续月数，每个数字可回溯 | T13 |
| T15 | 薄画像降级：`buildResume` 读 `authenticity.status`，`insufficient_data`/`suspicious` 时显式标注缺口 | 不再对空画像出"看似完整"的简历（PRD NFR-6 与 AGENTS 铁律） | — |
| T16 | 岗位定向面试准备单（岗位命中技能 + 对应证据 + 会被问到什么 + 该反问什么） | 纯规则、仍可回溯；替换今天"5 道通用题干"的 kit | T13, T14 |
| T23 | **中文交付物里剩余的英文句子**（T07 只修了 headline，真账号实测中文简历又露出 `50 PR(s) opened, 38 merged`）：`collaboration.prSummary`、`activity.cadenceSummary`、真实性信号的 `label`/`detail` 都是分析内核写的英文散文 | 中文简历/面试包里由内核生成的散文全部随读者语言；做法照 T07——事实留快照，模板收进 `shared`；`caveats` 与证据 `claim`（T-批次 41 已定英文口径）**不在本条范围** | T14 |

### 批次 4 · C-D 我的求职（产品第一次有账号感）

| # | 任务 | 完成判据 | 依赖 |
| --- | --- | --- | --- |
| T17 | "我的"页：接上**今天无人调用**的 `profiles.listBySubject`；让 `AccountMenu` 真正渲染它已收到的 `claimedProfileId`（`AccountMenu.tsx:19` 收了不用）；导航加入口 | 登录后有一页能找回自己的全部画像，关掉浏览器也不丢 | T03 |
| T18 | 求职者面试管道：复用 012 `interviews` 与行级归属，**换挂载点与文案**（从 `/recruit` 挪进"我的"），并把 `applicationId` 真接上（API 已支持推进投递状态、UI 从不传） | "我投了哪些 → 哪场面试 → 结果如何"一条链走通；不再要求"进前 100 候选人"才能建行 | T17, T03 |
| T19 | 融合画像可认领（Q2：任一源命中即可，记录实走平台） | `platform=all` 画像能出"本人已验证"，与 item58 的"未经本人认领"提示条互斥正确 | T17 |
| T20 | 推荐去重与翻页：剔除已保存/已投、加 offset 与关键词、跨源同岗位合并（今天只标记不合并） | 同一岗位不在推荐里出现两次；已投的不再推 | T17 |

### 批次 5 · 非代码前置（C 端代码救不了的）

| # | 任务 | 判据 |
| --- | --- | --- |
| T21 | 🔒 形态 C 控制台部署（Runbook §4-C / 执行单 A–J）→ 配 Actions secret `DATABASE_URL` → 手动跑一次 daily | **在此之前的岗位池是死的**：日更整条 gated 在未配置的 secret 上（`.github/workflows/jobs-sync.yml:66-86`） |
| T22 | 扩岗位种子清单：现成 Greenhouse/Lever 适配器再加 30–50 家真在招 AI 公司（**纯配置**） | 语料从"17 家自选"变成能代表市场；不动一行匹配逻辑 |

### 实测纠正（2026-09-25，T04 落地时）

1. **topics 是采集的**，我此前推测"L0 没取 repositoryTopics"是错的（`packages/github-source/src/graphql.ts:82/127` 就在取并映射）。真正的坑是 **topics 走小写精确相等**，所以 GitHub 的真实 topic 拼写（`agentic-workflows`、`mcp-servers`、`modelcontextprotocol`、`ai-agents`）必须逐字进别名表，带空格形态匹配不到。已按此补录并加守护用例。
2. **第一次"没有 AI 标签"的实测是假象**：`pnpm --filter @jobagent/cli build` 不会重建 `analyzer-core` 的 dist，CLI 跑的是旧产物（61 条目录）。**任何用 CLI 做的真账号实测之前必须先 `pnpm -r build`**，否则测的是上一个版本。
3. 全量重建后实测 `bayernjf`（GitHub 源、规则 0.1-0.3）：`ai agents` = **proficient / 置信度 0.85 / 5 条证据**，是该画像里置信度最高的框架标签，压过 react/postgresql/redis。T04 的"说得清我"这一条对用户本人成立。
4. **框架标签上限原为 8**（按 confidence 排序截断），AI 层进目录后把 `vue` 挤掉，已随 T05 提到 **10**（`skills.ts:280-283`）。但提到 10 也**没能把 vue 找回来**：真账号复测显示 `rag`、`model context protocol` 等真实标签一起进了前 10，`vue` 以 used/0.4 落到门外。结论要改口径——**这不是上限太小，是一堆并列 0.5 的弱信号在抢名额**；真要解决得让排序兼顾 depth 与仓库数，而不只看 confidence，留作 T14 一起处理。

5. **一条守卫差点是假的**：我最初把「单仓话题被门槛丢弃」和「最多 3 条上限」写进同一个用例，摘掉两仓门槛后测试**仍然全绿**——那条断言其实是被上限挤掉的，不是被门槛拦的。拆成两个独立用例之后，禁用门槛立刻变红。**一条用例不要同时守两件事**，否则它会对着错误的机制给绿灯。

6. **T06 挖出的第二个假数据**：Gitee 的 PR 映射把 `additions`/`deletions`/`changedFiles` **硬编成 0**（原 `gitee-source/src/mappers.ts:142-144`）。这三个字段自 2026-09-14 落地起**全仓零消费者**，所以那颗 0 从没被读到过；T06 一旦开始读，Gitee 画像就会宣称「此人合并了 0 行代码」。已改为 `null`（＝该证据源不提供），证据文案与统计指标一律「未知就整段缺席」，并用例钉住。教训：**采集层里没人读的字段不是中性占位值——它一直在等第一个读它的人把它当成事实。**

### 建议执行顺序

**T01–T03 与 T04–T08 并行开**（隐私与表达力无耦合）→ **T11**（一条小修复，立刻让简历能投出去）→ T09/T10 → T12–T16 → T17–T20；**T21/T22 越早越好**，否则批次 4 做完仍是"对着空岗位池挑"。

## 10. 一句话结论

产品今天**能证明一个人做过什么，却说不清他做的是 AI Agent、给不出他下一步该补什么、交出的简历还会把他的姓名邮箱弄丢**。C 端优先的真实含义不是加功能，是把这条链从"能算"修到"能用"：**先让它说得出我是谁（C-A），再让它告诉我缺什么（C-B），然后让它交得出东西（C-C），最后才让它管得住管道（C-D）**；而岗位是不是真的，取决于部署和种子清单，不取决于我们再写多少 UI。
