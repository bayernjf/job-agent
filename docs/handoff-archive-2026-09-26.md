# handoff 归档 · 2026-09-26

> 本文件为冻结归档（只读、不再追加）。对应 handoff.md 活跃待办 **item83 / item84 / item85**（T30 / T29 / T33，第三次 MVP 评审 §9 剩余纯代码项，用户点名"一口气搞 T29+30+33"）。主文件已各留一行结论；详细实现与验证过程在此。

## T30 · 岗位池口径对齐（item83）

**问题**：`GET /job-postings/stats` 自 2026-09-25 起按 7 天新鲜窗口报 `active:0`（`countActiveFresh(cutoff)` + `JOB_STALE_DAYS` 默认 7，`apps/api/src/index.ts:1274-1288`），而 CLI `jobs stats` 按状态列报 `active=2303`——同一件事两个表面讲两个故事，产品界面会给人"有 2303 条在招"的错觉。

**改动**（`apps/cli/src/jobs-commands.ts`）：
- `runStats` 增列"新鲜窗口内 N 条"：输出 `<source>\tactive=N\tinactive=N\tfreshWithin7d=N`，total 行追加 `freshWithin7d=N\tcutoff=<ISO>`。
- fresh 计数与 API 同源：`countActiveFresh(cutoff)`，cutoff = `now - JOB_STALE_DAYS`。

**踩坑**：cutoff 时钟第一版用裸 `Date.now()`，测试 harness 把 `deps.now` 固定在 `2026-09-13T00:00:00Z`，首跑断言 `freshWithin7d=1` 失败（实测 0）。修复：`deps.now ? new Date(deps.now!()).getTime() : Date.now()`——时钟必须走注入，测试才能固定。

**验证**：`apps/cli/src/jobs.test.ts` stats 用例补两条断言（`freshWithin7d=1`、`cutoff=` 前缀），rerun **7/7 绿**。

## T29 · 批次 6 三表面浏览器级验证（item84）

**背景**：第三次评审 §9 指出 `/my`、自选岗位表单、partial 提示条与 `?unavailable=1` 分流三个新表面零浏览器级用例；另有三件小坏事：简历岛被 `skillTags.length>0` 门控（零技能画像彻底没有出路，T15 同族）、`apps/api` 无显式 testTimeout（interviews/resume 两条用例曾撞线假红）、报告 E2E 冷路由在 CI 偶发 `page.goto` 30s 超时（item81 登记）。

### 代码改动

1. **简历岛门控**（`apps/report/src/pages/[locale]/report/[profileId].astro:424`）：`!isRecruiter && profile.skillTags.length > 0 && (` → `!isRecruiter && (`。
2. **apps/api vitest 配置**（新建 `apps/api/vitest.config.ts`）：`testTimeout: 15000, hookTimeout: 15000, include: ['src/**/*.test.ts']`。
3. **E2E 冷路由预热**（新建 `e2e/preload.ts`）：`preloadAstro(baseURL)` 串行 fetch 预热 `/zh-CN/`、`/en/`、`/zh-CN/my`、`/zh-CN/?unavailable=1`、`/zh-CN/?notfound=1`、6 个 fixture 画像报告页（zh-CN）+ 1 个（en）；每请求 6s 超时只 warn。挂到字母序首 spec `e2e/account-auth.spec.ts` 与 `e2e/gated-content.spec.ts` 的 `test.beforeAll(() => preloadAstro('http://127.0.0.1:4321'), { timeout: 120000 })`。
4. **Fixtures 扩展**（`e2e/fixtures/sample-profile.ts`）：新增 `FIXTURE_PARTIAL_PROFILE_ID='profe2efixture00000000000005'`/`FIXTURE_PARTIAL_LOGIN='e2e-partial-user'`、`FIXTURE_EMPTY_LOGIN='e2e-empty-user'`/`FIXTURE_EMPTY_SESSION_TOKEN='ses-e2e-empty-token'`；`buildPartialFixtureProfile()`（`analysisLayers:['L0']` + `authenticity:{status:'insufficient_data',confidence:0.35,signals:[]}`）；`FIXTURE_PROFILE_IDS` 加入 PARTIAL id。
5. **global-setup 种子**（`e2e/global-setup.ts`）：partial 画像存储行（`status:'partial'`）＋空态账号（`acc-e2e-empty`/provider 9002/`FIXTURE_EMPTY_LOGIN` + `FIXTURE_EMPTY_SESSION_TOKEN` 会话，2030 过期）。Auth 会话 cookie 名 `AUTH_SESSION_COOKIE='jobagent_session'`（`packages/shared/src/index.ts:588`）。
6. **新 spec**（`e2e/batch6-surfaces.spec.ts`，三个 describe 共 7 用例）：
   - `/my` 三态：匿名登录墙（`data-testid="my-gate"` + return_to 深链）/ 本人登录见两个画像链接（`.my-profile-link[href="/zh-CN/report/..."]`）/ 空账号见 `.my-empty` 且 `.my-profile-list` 计数 0。
   - partial 提示条（`data-testid="partial-notice"` 含"部分数据"）＋ home 分流（`data-testid="unavailable-notice"` / `notfound-notice`）。
   - 自选岗位表单：mock `**/resumes/build`，填 `.resume-builder` 两个 input + textarea → 按钮 → `.resume-iframe` 内 `#marker` 含岗位标题。

### 全量 E2E 首跑暴露的两个真问题（均修复）

**① report-render.spec.ts:35 信号标题找不到 `External PRs merged`**：fixture 手写信号 code 是无版本前缀的 `external_contributions`，`composeSignalLabel` 未知 code 原返回 code 本身。修复（跨批属 T33 面）：composer 增 `fallbackLabel` 参数——未知 code 退回快照英文 label（en 不变原则），`[profileId].astro` 与 `interview-kit.ts` 调用点传 `signal.label`，shared 测试同步改；同时 `SIGNAL_LABELS` 中 stale_activity en 从 'No recent activity' 对齐为快照 warn 档 'No activity in the last year'。

**② batch6 self-select 按钮 disabled**：冷路由 island chunk 编译慢 → React hydrate 晚于 fill → 受控值被重置、事件丢失。修复：fill 后 `expect(genBtn).toBeEnabled({timeout:4000})`，catch 内重填 title+textarea 再 `toBeEnabled({timeout:15000})` 再 click。

### 验证

- batch6 单独 spec **7/7 绿**（预热有效，2.3–2.8m）。
- report-render + batch6 单跑 **18/18 绿**。
- 全量 `pnpm e2e`：首跑 **77 用例 2 败** → 修复后 **77/77 全绿**（4.6m）。
- T29 完成判据中的"CI 连续 5 run 无 `page.goto` 超时"为本机无法证明项，如实留给 CI 侧（CI 未上传 test-results 产物，排查需 error-context 的痛点仍在）。

## T33 · 内核散文收尾（item85，规则 0.6→0.7）

**背景**：T23（简历侧）完成后剩余的内核散文面——面试准备包原样打 `signal.label`/`detail`（信号只有 code + 散文，百分比/比率在文字里渲染侧拿不到数）、`interviewQuestions[].question`/`intent`（连 code 都没有）、报告页打 `cadenceSummary` 与带外部贡献片段的 `prSummary`（`externalMergedContributions` 是去重后 ≤5 个仓库名，不能当 PR 数用）。方法学铁律：内核散文＝数据层英文原文存快照；面向读者句子由 `packages/shared` composer 现拼 `(facts|code, locale) => string`；渲染侧只认 code/facts 绝不按英文句子匹配；取不到的事实不许编（宁退回快照英文原句）；新增 facts/字段必须升 `RULE_VERSION`（缓存与分享链接的可复现性）。

### 改动

1. **`packages/shared/src/index.ts`**：
   - `SignalFactsSchema`：`z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]))`。
   - `AuthenticitySignalSchema` 增 `facts?: SignalFactsSchema`。
   - `InterviewQuestionKindSchema` 枚举：`self_repo_depth` / `external_pr` / `high_star_design` / `language_depth` / `issue_diagnosis`；`interviewQuestions` 项增 `kind?`/`facts?`。
   - 新 composer（追加在 `composePrSummary` 之后）：`composeSignalLabel(code, locale, fallbackLabel)`、`composeSignalDetail(code, locale, fallbackDetail, facts)`、`composeInterviewIntent(kind, locale, fallbackIntent)`、`composeCadenceSummary({commits, months}, locale)`。
   - `prSummaryFactsFromProfile` 增读 `metrics.externalMergedPullRequests`（有才填 externalMerged）。

2. **`packages/analyzer-core/src/signals.ts`**：全部 11 条信号生产者补 `facts`：
   - `author_inconsistency` 四档 → `emailMatchPct`/`nameMatchPct`
   - `commit_burst` → `commits`/`months`
   - `stale_activity` → `monthsAgo`
   - `star_activity_mismatch` → `stars`/`commitContributions`
   - `star_to_commit_ratio` → `stars`/`commits`/`ratio`/`established`
   - `empty_activity` → `behaviorTotal`/`commitContributions`
   - `short_longevity` → `months`
   - `external_contributions` → `externalMergedCount`/`strong`
   - `self_pr_ratio` → `selfCount`/`total`/`selfPct`
   - `low_diversity` → `repoCount`/`language`
   - `narrow_activity_scope` → `top1CommitSharePct`/`prCount`/`externalMergedCount`（+`eventTypeCount`/`distinctRepoCount` 有 behavior events 才写）

3. **`packages/analyzer-core/src/questions.ts`**：5 类题目补 `kind`+`facts`（self_repo_depth→repo/commitCount；external_pr→repo/prNumber/title；high_star_design→repo/stars；language_depth→language/repo；issue_diagnosis→repo/issueCount）。

4. **`packages/analyzer-core/src/activity.ts`**：metrics 增 `externalMergedPullRequests`（`!p.repoOwnerIsSelf && p.state === 'MERGED'` 计数）。

5. **`packages/analyzer-core/src/rules.ts`**：`RULE_VERSION` `'0.6'` → `'0.7'`。

6. **渲染面**（`apps/report/src/pages/[locale]/report/[profileId].astro` + `apps/report/src/lib/interview-kit.ts`）：信号标题/描述、cadence 现拼、prSummary（facts null 退快照英文原句）、面试题 intent 全部改走 composer；import 五个 composer。

### 守卫

- `packages/analyzer-core/src/signals.test.ts`：`expectFactsForAllSignals`（断言每条信号 facts 存在非空，挂到"produces no risk signal"用例）。
- `packages/shared/src/index.test.ts`：`describe('T33 composers (facts + code driven)')` 6 用例——composeSignalLabel 未知 code 回退、缺 facts 退英文原句、composePrSummary 外片段 en/zh 等。
- `packages/analyzer-core/src/profile.test.ts`：deterministic 用例加 `metrics.externalMergedPullRequests` 断言；既有两条硬断言（`analyzerVersion === \`${SCHEMA_VERSION}-${RULE_VERSION}\`` 与 PR summary 旧字面量逐字节钉住）继续通过（buildInput 的 external=0 故英文输出不变）。

### 验证

- `pnpm --filter @jobagent/shared test`：**99/99**。
- `pnpm --filter @jobagent/analyzer-core test`：**87/87**。
- 全仓 `pnpm -r test`：无 FAIL（cli 64、api 190、report 61、shared 99、analyzer-core 87，总数见主文件最近变更）。
- 全仓 `pnpm -r build`：0 TS error。
- `bash tools/check-migrations.sh`：14 对 0 warning。
- `git diff --check`：干净。
- 报告 E2E 全量 **77/77**（含 T29 新增用例与 T33 渲染面改动）。

### 方法学备忘（延续 item62–82）

- 改 shared/analyzer-core 类型后，下游 typecheck 与 CLI 实测前必须 `pnpm -r build`（至少 `pnpm --filter @jobagent/shared build`；`--filter @jobagent/cli build` 不重建 analyzer dist 已多次验证）。
- `Edit` 工具读态卡死时改用 python in-place 替换（本批对 10+ 文件全部走 python 通道成功）。
- 每个 Bash 独立进程，fnm use 不跨命令保留；跑 native 前 `eval "$(fnm env --shell bash 2>/dev/null)" && fnm use 24.0.0`。
