# Handoff 归档 — 2026-09-25

> 跨天冻结、不再追加；同一天（2026-09-25）的后续批次按 § 续记。记录从 handoff 主文件裁出的 item68–74 明细（第三次 MVP 评审批次 6 + T17 提前 + T09）。
> 归档时本批 6 个英文原子提交均在本地 `dev`、**未 push**：`5e144a4` → `20af4d8` → `0f5cb21` → `770d6cb` → `7727fc9` → `7607256`。

## 1. 批次 6 总览（第三次评审 §7，2026-09-25）

评审判定未达"核心完全可用 MVP"的四条阻断（T24 岗位池真实写入/简历不依赖池、T25 失败显式化、T26 删除解绑最小版、T27 三条 fail-open 收口）+ T17「我的」页提前（P0-3 回访即失联）+ T09 improvementSuggestions 生产者，全部落地。

### 全量门禁（Node 24.0.0，本机 macOS）

- `pnpm -r typecheck` exit 0；`pnpm -r build` exit 0。
- `pnpm -r test` exit 0：storage 126 passed/11 skipped（PG 行为测试无 `DATABASE_TEST_URL` 时 skip）、worker 31、cli 64、api **190**、report 61，其余包全绿。
- `bash tools/check-migrations.sh` 两侧文件集合对齐 0 warning；`git diff --check` 干净。
- 四条文档守护（api-doc-consistency / env-doc-consistency / doc-links / doc-commands）随 test 实跑通过。

## 2. item68 · T25 失败显式化

**基础设施先行再逐层接线：**

- storage：`IProfilesRepository.updateSnapshot(id, patch)` 六字段 PATCH、`IEvidenceRepository.deleteByProfile(profileId)`（物理删证据，与 T26 共用）。
- 采集器两段式：`collect()` 重构为 `collectStagedL0(login)`（opaque handle + `missing:['l1_pending']` 轻输入）与 `collectStagedL1(login, handle)`（复用 handle；L1 任何失败含 budget_exhausted 不上抛，降级仅 L0 输入并 `missing:['l1_failed']` + `l1Error`）。
- worker：`StagedEvidenceSource` 接口；单源分支 L0 → analyze(layers:['L0']) → 落 `status:'partial'` 画像 + 导入 L0 证据 → `jobs.succeed(...,['l1_pending'])` → 同任务内 L1 → `updateSnapshot`（status 按 missing=partial/complete）→ `evidence.deleteByProfile` + 重导入 → `jobs.succeed` 幂等重写；两处 `profiles.insert` 均 `status: missing.length>0?'partial':'complete'`（全仓唯一一次 insert 不再硬编 complete）。测试 fake 源（无 staged 方法）自动回退一次性 collect。
- 报告页：`loadProfileRecord` 不再吞 DB 异常；`[profileId].astro` 区分 `?unavailable=1`（DB 故障）与 `?notfound=1`（不存在）；`status==='partial'` 渲染 partial 提示条；`index.astro` 消费两个参数字段。
- 轮询有界：`AnalyzeForm` `POLL_TIMEOUT_MS=5*60*1000` + `pollStartedAtRef`，超时显式报 timeout 文案。
- API by-subject：接受 `complete||partial`（扩展一键填充依赖），测试从期望 404 → 200 + status:'partial'。
- i18n：`home.notFoundNotice` / `home.unavailableNotice` / `report.partialNotice`；global.css 加 `ja-alert--warn/error/partial` 提示条（error 用 `--ja-color-danger-{bg,fg,border}`，**拒绝 hex fallback**）。

## 3. item69 · T24 岗位池真实写入 + 简历不依赖池子

- ① 新鲜度：`IJobPostingsRepository.countActiveFresh(cutoffIso)`（sqlite+postgres 双实现）；`GET /job-postings/stats` 改用 `JOB_STALE_DAYS`（默认 7）算 cutoff，响应 `{active,inactive,staleAfterDays,cutoffIso}`。
- ② 自选岗位入口：`ResumeBuildRequestSchema` 改 jobId|posting 二选一（`.refine(Boolean(jobId)!==Boolean(posting))`）；`posting {title, company?, description}` 构造 `JobPosting`（jobId=`manual-<uuid>`、source:'manual'、sourceUrl=`https://manual.local/<uuid>`）→ 复用 matchJobs→fromJobMatch→buildResume，不入池不落库。resume-core render（html/markdown）company 空时省略 `@ company`。
- ③ ResumeBuilder 前端：manualHint/manualTitle/manualCompany/manualJd/manualGenerate/manualMissing 文案、按钮 disabled 当 title/description 空、ready 面板 company 空省略；i18n +9 键。

## 4. item70 · T26 删除与解绑最小版

- `IProfilesRepository.deleteById(id): Promise<boolean>`（接口 + sqlite `info.changes>0` + postgres `.returning({id}).length>0`）。
- 新 CLI 子命令 `jobagent profiles delete --profile <id>`：删画像 + `evidence.deleteByProfile`，撤分享链（报告页/API 即 404）；退出码 0 / 2（缺参）/ 1（不存在或存储错误）；4 条测试全通过。

## 5. item71 · T17「我的」页（P0-3 回访即失联）

- 新页 `apps/report/src/pages/[locale]/my.astro`：SSR `resolveViewer` + `getStorage()`，未登录 GateCard 登录墙（loginHref 带 return_to=/\<locale\>/my）；登录后 `profiles.listBySubject(platform, login)` 渲染画像列表（headline/status 徽标/updatedAt 日期格式化）；空态引导去分析。
- `Layout.astro` nav 加 `<a href=/${locale}/my>`（`nav.my`）；AccountMenu 接收新 props `locale/myLabel/claimedLabel`；user 分支新增"我的"链接 + `claimedProfileId` 深链（data-testid my-claimed-profile）。
- i18n：`nav.my` + `my.*` 共 9 键，zh/en 各 **317 keys**；status 徽标 partial 用 `--ja-color-accent-subtle`/`accent`（**warning 色板本就无 bg/fg 对，勿用**）。

## 6. item72 · T09 improvementSuggestions 生产者

- 新 `packages/analyzer-core/src/suggestions.ts`：`computeImprovementSuggestions(input)` 两条保守规则——commits≥10 且 pullRequests==0 → "open pull requests…"；mergedExternal==0 且 pullRequests>0 → "contribute to external projects…"；每条必须挂真实存在证据（`refsByType('commit'/'pr')`，无 ref 不产）；英文数据层散文。
- `profile.ts` 装配 `...(improvementSuggestions ? { improvementSuggestions } : {})`；`rules.ts` RULE_VERSION **0.4 → 0.5**。
- 3 条测试（含"两条件都不满足 → undefined"）。

## 7. item73 · T27 fail-open 三条收口

- ① 死旋钮接上：`DemoRateKind` 扩展 `'match'`（entities/demo-session.ts）；`/job-postings/match` demo 分支先查 `countRateEvents(ipHash,'match',...)` ≥ `cfg.matchRatePerHour` 则 429 `{bucket:'match', retryAfterSeconds:3600}`，再 `incrementMatch`；局部用 `matchNow = now()`（勿引用不存在的 nowIso）。
- ② `POST /resumes/build`：`polish===true` 且 principal.kind!=='user' → 403 `{code:'AUTH_REQUIRED'}`（匿名不再能烧 LLM 付费额度）；规则版/无 polish 保持公开。
- ③ 生产启动闸：`createApp` 在 `cfg.isProduction` 下缺 `CRON_SECRET` / 未显式设 `TRUST_PROXY` 直接 throw——fail-fast 而非运行时静默降级。
- 测试：`index.test.ts` 新增 T27 describe 3 例（match 429 用例：预插一条 `now` 的 match 事件 + x-forwarded-for + trustProxy:true + ipSalt 固定；polish 403；生产启动双 throw 用例临时保存/恢复 process.env）。

### 踩坑记录（本批实测教训）

1. **测试时间窗口差毫秒**：match 429 用例最初插入 `oneHourAgo(now)` 的事件，请求内 `now()` 又晚几毫秒 → `createdAt > since` 恒 false → 永远 200。改为插"刚刚发生"（`new Date().toISOString()`）的事件后 429 正常触发。
2. **T27 改 handler 行为必须同步改造既有测试**：`/resumes/build` 加身份闸后，resume.test.ts 的 polish 用例全部 403——新增 `loginCookie(repos)` 助手（仓储层 `accounts.upsertFromProvider` + `authSessions.create`，Cookie `jobagent_session=sess-alice`，`AUTH_SESSION_COOKIE` 从 `@jobagent/shared` import），4 个 polish 真用例全部带 cookie。
3. **suggestions.test.ts 类型**：`noUncheckedIndexedAccess` 下 `got![0]` 仍报 possibly undefined——先 `?? []` 归一再用 `got[0]!`；fixture 断言 `as unknown as AnalyzerInput`（`as` 直转类型不重叠报 TS2352）。
4. **postgres `deleteById` 判成功**：`result.rowCount` 类型不成立（Drizzle 返回 RowList），正确姿势 `.returning({ id: table.id })` 后取 `.length`。

## 8. item74 · 全量验证 + 文档回写 + 原子提交

- 验证数据见 §1；方案 `docs/design-c-side-first-20260925.md` §9 任务表 T09/T17/T24–T27 已打勾、批次顺序行已更新。
- 归档即本文档；handoff 主文件 item68–74 保留一行结论 + commit hash（详见 handoff.md）。

## 9. 本批 commit 链（全部本地、未 push）

| hash | message |
| --- | --- |
| `5e144a4` | feat(storage): add profile delete, snapshot update and fresh-job count |
| `20af4d8` | feat(worker): stage L0/L1 collection with explicit partial profiles |
| `0f5cb21` | feat(analyzer): emit evidence-backed improvement suggestions |
| `770d6cb` | feat(api): accept manual postings, gate polish and lock prod startup |
| `7727fc9` | feat(cli): add profiles delete subcommand |
| `7607256` | feat(report): add my-jobs page and explicit failure states |
