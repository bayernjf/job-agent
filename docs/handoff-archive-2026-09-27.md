# Handoff 归档 2026-09-27

> 归档惯例（对齐 agent-world）：主文件只保留「项目当前状态 + 活跃任务 + 最近 5 条变更 + 文档索引」，编号待办标 ✅ 后详细过程整块滚入本文件；**归档文件冻结只读、不再追加**。
> 本文件收：item86 补录（T13/T14/T16，2026-09-26 落地但当时未归档）+ item87（T15/T22/T19/T18/T20，2026-09-27）。

---

## §1 item86 补录：T13 项目条目抽象 + T14 量化行进交付物 + T16 岗位定向面试准备单（2026-09-26）

评审 §9 批次 3「C-C 交得出东西」收尾。用户拍板推进 T13→T14→T16 链。

- **T13 项目条目抽象**：`shared` 增 `ProjectEntrySchema`（project/action/title/scale/url/occurredAt/evidenceRefs，superRefine 强制 refs 非空＝no-fabrication 结构化抓手）；`resume-core` 新 `project-entries.ts` 只解析两源自产稳定 claim 格式（PR 含 T06 `+A/-D across N files` 后缀 / Issue / Commit fallback / Repo stars-forks），解析不出跳过不猜；`ResumeDraft.projectEntries` 默认 `[]` 兼容旧草稿；md/html 增「项目经历」区块（PR 带规模、Issue/Commit/Repo 各一行，均挂可点击证据链接）。
- **T14 量化行进交付物**：`buildSummary` 增量化句（mergedPullRequests/commitRepoCount/activeMonths 三键齐全才写，缺任一整句省略、不写半句不猜数，旧快照天然兼容）；`interview-kit` 增「量化概览」小节同口径；数字全部直取快照 `activity.metrics` 可回溯。
- **T16 岗位定向面试准备单**：`renderInterviewKit(profile, evidence, locale, opts?)` 增可选岗位输入——`interview-kit.md` 端点读 `?jobId=` → `jobPostings.getById` + `matchJobs` 定向（report 新增 `@jobagent/job-source` workspace 依赖；任何失败降级通用版不 500），渲染「岗位定向准备」（岗位 + 命中技能逐条挂证据行）与「你该反问什么」（纯规则按命中技能生成）；无 opts 保持通用版向后兼容。
- **RESUME_RULE_VERSION 0.1→0.2**（排序/模板变更）。
- **验证**：CLI 端到端冒烟（preset-bayernjf × 真实岗位 JSON）量化句 `已合并 36 个 PR，覆盖 10 个活跃仓库，持续 87 个月` + 项目经历五类条目全部正确；门禁全绿：typecheck/build/check-migrations 14 对 0 warning/`git diff --check` 干净，全仓单测通过（resume-core 46、report 65、api 190 等）。

---

## §2 item87：T15 薄画像降级 + T22 扩岗位种子清单 + T19 融合画像可认领 + T18 求职者面试管道 + T20 推荐去重与翻页（2026-09-27）

评审 §9 A 组纯代码 5 项一口气闭环，均无外部依赖。**5 个英文原子提交，未 push**：`e3772a6`（T15）→ `66354d8`（T22）→ `cc409ee`（T19）→ `af3b71e`（T18）→ `9546b3b`（T20）。作者 bayernjf、无 co-author。

### T15 薄画像降级（`e3772a6`）

- `ResumeDraftSchema` 增可选 `dataQualityNote`；`tailor.ts` 读 `authenticity.status`，命中 `insufficient_data`/`suspicious` 时设 note 并 push 进 `gaps`；md/html 渲染「数据说明」小节（`.notice` amber 样式）。
- 不再对空画像出"看似完整"的简历（PRD NFR-6 与 AGENTS 铁律）。
- render 套件 13/13 绿（+2 用例）。
- **注意**：改 shared 契约后必须 `pnpm --filter @jobagent/shared build` → `pnpm --filter @jobagent/resume-core build` 再跑测试。

### T22 扩岗位种子清单（`66354d8`）

- `packages/job-source/src/adapters/registry.ts` 的 `SEED_GREENHOUSE_BOARDS` 8→45 家（brex/coinbase/databricks/anthropic/elastic/twilio/vercel/reddit/assemblyai/stabilityai/chime/pinterest/webflow/block/mixpanel/newrelic/lyft/lattice/airbnb/remote/pagerduty/gusto/wise/monzo/duolingo/deliveroo/n26/wolt 等，附"2026-09-26 实测 200"注释）。
- Lever 候选 64 家全 404 零新增；探测脚本在 /tmp 不入库。
- job-source 测试 78/78 绿。纯配置，不动一行匹配逻辑。

### T19 融合画像可认领（`cc409ee`）

- 原始断点：API claim 段要求 `profile.subjectPlatform === principal.platform`，而融合画像存 `'all'` → 双源登录都 403；且报告页 `!isFusedProfile` 条件不挂 ClaimProfile。
- 落地：判定改 `subjectPlatform==='all' ? subjectLogin===principal.login : 平台+login 双等`（403 body 保持 `subject:{platform,login}`）；`ClaimResultSchema.subject.platform` 在 shared 扩为 `PlatformSchema.or(z.literal('all'))`（API 返回处加 `as 'github'|'gitee'|'all'` 窄化）；`ClaimProfile.tsx` subjectPlatform 类型扩为三值并支持 all 判定；astro 去 `!isFusedProfile`，`subjectPlatform={isFusedProfile?'all':profile.subject.platform}`。
- 测试：`auth-flow.test.ts` 的 `insertProfile` 加第 4 参（默认 'github'），新用例"lets either source claim a fused platform=all profile with the same login"（GitHub alice 认领 alice/all→200 且 body.subject.platform='all'；Gitee bob 认领 bob/all→200；Gitee bob 认领 alice/all→403 `AUTH_NOT_PROFILE_OWNER`），auth-flow 21/21 绿。
- **踩坑**：把 Gitee 会话与 GitHub repos 混用会 401≠403，须在同 app+repos 内判定。

### T18 求职者面试管道（`af3b71e`）

- 判据原文"复用 012 interviews 与行级归属，换挂载点与文案（从 /recruit 挪进我的），把 applicationId 真接上，不再要求进前 100 候选人"。
- 落地：`InterviewPlanner.tsx` 整文件重写——`Candidate` 下拉改为「我的投递」`Application` 下拉（`id=ivp-application`，仅列 `BUILDABLE_STATUSES={'saved','applied','viewed'}`，选择后自动带出 targetTitle→role、targetCompany→company）；登录后 `resolveMyProfile()`（claimedProfileId 优先，否则 GET `/profiles/by-subject/:platform/:login`），POST payload 带 `applicationId`；登录但无画像 → `data-testid="interview-no-profile"` 引导；completed 才展开 `interview-result`。
- `my.astro` 在 `viewer.kind==='user' && profiles.length>0` 条件下挂载；`recruit.astro` 移除 InterviewPlanner 挂载块；i18n `interviews.*` 改求职者口吻并删除 `interviews.candidate`/`candidatePlaceholder` 两个 key（中英各仍对齐）；E2E 重写为"登录墙（my-gate + return_to=%2Fen%2Fmy）+ 从投递建行（断言 POST body 含 `applicationId:'app-e2e-1'`）+ 流转 completed/record outcome"3 用例。
- **修复的 bug**：my.astro 挂载块多出重复 `)}` 导致 Astro `CompilerError: Unexpected token`（[locale]/my.astro:76:5），删除后 E2E 3/3、全量 77/77 绿。

### T20 推荐去重与翻页（`9546b3b`）

- 判据"剔除已保存/已投、加 offset 与关键词、跨源同岗位合并（今天只标记不合并）| 同一岗位不在推荐里出现两次；已投的不再推"。
- 落地分层：
  - 纯函数（`packages/job-source/src/match/job-match.ts`）：`JobMatchCriteria.keyword`（归一化子串硬过滤 title/tags/description）；`excludeAndMergeMatches(matches,{excludeJobIds})` → `{items, excludedCount, mergedCount}`，key=`company.toLowerCase()+normalizeSegment(title)`，**保留 score 最高副本为主项**（输入顺序无关），其余折叠进 `alternateSources`（按 sourceUrl 去重，同源异常重复也折叠）。
  - API `GET /profiles/:id/job-recommendations`：新增 `offset`（非负整数）/`keyword`（trim，空串→undefined）query；`principal.kind==='user' && !requireProfileOwner` 时用 `repos.applications.listByProfile` 的 jobId 集合做 excludeJobIds；先 dedupe 再 `slice(offset, offset+limit)`；响应加 `total=deduped.items.length`、`excludedCount`、`mergedCount`、`offset`，每条 match 带 `alternateSources`。
  - API `POST /job-postings/match`：`JobMatchRequestSchema` 加 `offset`；同样的 dedupe/exclude/slice；响应加四个字段。
  - 报告页 `JobRecommendations.tsx`：`alternateSources` 渲染为 `.rec-alt` 可跳转来源链；新增 `loadMore`（offset 状态 + hasMore、追加并去重已见 sourceUrl、合并 evidence）、`.rec-load-more` 按钮；props 加 `loadMoreLabel`/`alternateSourcesLabel`。astro 页补两个 label prop。i18n zh/en 各加 `report.recommendations.loadMore`、`report.recommendations.alternateSources`（各 330 key 对齐）。
  - 测试：`job-postings.test.ts` +3（keyword 过滤；offset 翻页 + dedupe counts + alternateSources；已投剔除的匿名可见性——未登录不剔除）；`job-match.test.ts` +4（keyword 子串；exclude 计数；跨源合并 alternateSources + 同源折叠；最高分主项）。
- **修复的两个关键 bug**：
  ① `excludeAndMergeMatches` 忘记在 `packages/job-source/src/index.ts` re-export，导致 API 500 `excludeAndMergeMatches is not a function`（第一处补丁位置写错抛 AssertionError，修正到正确 export block 后好）；
  ② **limit 误传入 matchJobs 导致 total 随页大小变化**（limit=2 时 total=1）——这是本轮最后一个红测试的根因：端点把 `limit` 传给 matchJobs 截断匹配后再 dedupe，`total=deduped.items.length` 就只剩一页的量。修复：两个端点 matchJobs 都不传 limit，limit 只用于 `slice(offset, offset+limit)`（total=去重后全量、稳定）。
- **验证汇总**：api job-postings.test.ts 24/24、job-match 16/16、全仓 typecheck/test（api 194、job-source 78、report 65、worker 32、cli 64、llm 18、gitee 40、github 27 等）/build 全绿、check-migrations 0 warning、E2E 77/77、`git diff --check` 干净。
- **提交拆分**：index.ts 与 [profileId].astro 与 i18n 三文件跨主题，用 `git add -p` 按 hunk 分入 T19/T20；i18n 尾部 hunk（`my.claimedLabel` 后连续块）同时含 T18 的 5 个 interviews key 与 T20 的 2 个 recommendations key，无法按行拆，一并归入 T20 commit（body 已注明）。

---

## §3 本批 commit 链

```text
e3772a6 feat(resume-core): annotate data quality for thin profiles
66354d8 chore(job-source): expand greenhouse seed boards to 45
cc409ee feat(api): claim fused platform=all profiles from either source
af3b71e feat(report): move interview planner into my page for candidates
9546b3b feat(job-source): dedupe recommendations, filter applied jobs, add paging
```

未 push；push 后 `pr-helper-by-bayernjf` 会在约 5 分钟内自动建并合 `dev → main` PR。
