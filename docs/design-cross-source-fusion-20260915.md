# 跨源镜像去重与最小双源融合设计（B-5）

> 日期：2026-09-15（B-5 内核 + CLI）／2026-09-16（在线融合，见 §8）　状态：现行
> 范围：① B-5：新增 `packages/analyzer-core` 纯函数 + CLI 最小入口（不改 shared 契约、不改规则版本）；② **§8（2026-09-16 落地）**：把同一融合能力接入在线 API/Worker，`POST /analyze platform=all` 一次作业采双源、融合成一张画像。
> 关联：deferred #12「跨源 GitHub/Gitee 镜像项目去重、多源融合画像」。去重内核 + CLI 最小融合 + **在线多源融合**（§8）+ **跨源 PR/issue 同帖去重**（§8.7，7 天窗 2026-09-18 拍板锁定）+ FusionReport 随快照持久化（item23）均已落地；`platform=all` 融合作业按 2x 扣演示配额（§8.5，2026-09-18 落地）。仍缓做：Gitee OAuth 认领、认证态精确限频、跨源 L2 内容比对。

## 1. 背景与问题

同一开发者常把同一个项目同时放在 GitHub 与 Gitee（Gitee 支持一键导入 GitHub 仓库，国内常见镜像）。未来把两个源的数据合为一张画像时，若直接拼接会：

- 同一逻辑仓库出现两遍，**repo 数翻倍**；
- 同一批 git commit 在两源各一份，**commit 数/活跃度虚增**；
- 语言占比、技能标签计数、时间跨度被重复加权，真实性与能力结论失真。

B-5 提供一个**纯函数**把两份 `AnalyzerInput` 融合为一份去重后的 `AnalyzerInput`，并产出可解释的融合报告。内核 `analyze()` 只看到一份普通输入，**对"融合"无感知**（符合内核不感知来源的硬约束）。

## 2. 目标 / 非目标

**目标**

- 可靠识别"两个源上的同一个仓库"并去重；重复 commit 只计一次；融合结果可直接喂给 `analyze()`，且所有证据引用自洽（无悬空 evidenceId）。
- 纯函数、零 I/O、确定性，用构造夹具充分单测（默认不打真实平台）。
- 给 CLI 一个最小双源入口 `analyze <user> --platform all` 作为消费方与手动验证手段。

**非目标（继续缓做，触发条件不变）**

- ~~**不做在线 API/Worker 多源融合**~~ **已于 2026-09-16 重启落地，见 §8**（一个 job 采双源、融合一张画像；成本翻倍与降级语义见 §8.3/§8.6）。
- 不新增 shared `PlatformSchema` 枚举值（融合画像 `options.platform` 取主源 `github`）；不改 `AbilityProfile`/`AnalyzerInput` 字段结构；融合报告只随 CLI `meta` 输出，不进持久化画像。
- ~~不做跨源 PR/Issue 的"同帖去重"~~ **已于 2026-09-17 重启落地（item22，见 §8.7）**：仅在已确认强镜像配对仓内、同类型（PR/issue 分键空间、绝不跨类型）、标题规范化相同、创建时间差 ≤7 天窗时保守一对一去重；非镜像仓/窗外/标题不同仍保留为真实跨平台活动。
- 不做 LLM 语义判重、不做仓库内容比对（那需要 L2 clone）。
- `batch` 暂不支持 `--platform all`（双源请求翻倍，融合主要服务单账号深度画像）。

## 3. 镜像判据：强判据自动并，弱判据只报不并

| 级别 | 判据 | 处理 |
| --- | --- | --- |
| **strong（确定镜像）** | 两个仓库存在**相同 commit oid（git SHA）**。git commit hash 由内容/作者/时间/父提交决定，跨平台全局一致，是铁证 | **自动合并去重** |
| **weak（疑似）** | 仅仓库短名相同（小写）但**无共享 oid**（常见于 blog/dotfiles/test 等同名巧合，或一边没采到 commit） | **只写进 `suspectedMirrors`，不合并** |

算法：

1. 用辅源 `commits` 建 `oid -> secondaryRepoRef` 索引。
2. 对主源每个仓库，统计其 commit oid 命中辅源各仓库的数量；共享 oid 数最多者配为 strong 镜像（共享数 ≥1），已配对的辅源仓库不再配给其他主源仓库（一对一）。
3. 剩余未配对的主/辅仓库按短名小写相等配为 weak 疑似，仅报告。

> 刻意保守：宁可漏并一个真镜像（它只是被当成辅源独有仓保留，不会算错，只是没"合并视图"），也不错并两个同名不同物的仓库。

## 4. `fuseInputs` 融合规则

签名：

```ts
fuseInputs(
  primary: AnalyzerInput,   // 主源（通常 GitHub，信息更全）
  secondary: AnalyzerInput, // 辅源（通常 Gitee）
  platforms?: { primary?: SupportedPlatform; secondary?: SupportedPlatform },
): { input: AnalyzerInput; report: FusionReport }
```

逐字段：

- **repos**：主源全保留为基底；strong 镜像把辅源 repo 并入主源 repo；未被镜像的辅源 repo 原样追加。镜像合并取值：
  - `topics` 去重并集（保序、小写不敏感）；`description`/`primaryLanguage` 主源优先、空则取辅源；
  - `stargazerCount`/`forkCount` 取 **max（不相加，同一项目热度不翻倍）**；
  - `pushedAt` 取较新、`createdAt` 取较早；`isArchived` 任一为真则真；`isFork`/`url`/owner/name 取主源。
- **commits**：主源全留；辅源 commit——
  - 属于镜像仓且 oid 已在主源出现 → **丢弃（重复，计入 `dedupedCommitCount`）**；
  - 属于镜像仓但 oid 主源没有（辅源补到的提交时序）→ 保留，`repoName` 重映射到主源 repoRef；
  - 属于辅源独有仓 → 原样保留。最终按 `(repoName, oid)` 去重、时间升序。
- **pullRequests / issues**：不跨源去重；属于镜像仓的辅源 PR/issue 把 `repoNameWithOwner` 重映射到主源 repoRef 后保留（编号、URL 仍是 Gitee 的，作为"该项目在 Gitee 也有协作"的真实证据）；辅源独有仓的原样保留。
- **evidence**：主源原样；辅源 repo 证据（镜像仓 `repo:辅ref`）丢弃（并入主源 repo 证据）；辅源 commit/pr/issue 证据随数据**重写 evidenceId 的 repo 段为主源 ref 以通过内核 known 校验，但保留 Gitee 原始 url 供溯源**；最后按 evidenceId 去重。镜像仓两源同号 PR 致 evidenceId 撞车的极罕见情况按去重保留一条（保守，文档标注）。
- **contributions**：**以主源为基底、不与辅源相加**（平台统计值含镜像，相加必虚增；辅源独有仓的 commit 已进入 `commits` 供时序/广度信号使用）；`contributionMonths` 取主源。辅源原始贡献计数记入 report 备查。
- **behaviorEvents**：两源都有则 `totalEvents`/`eventTypeCounts` 相加、since/until 取并，`distinctRepoCount` 保守取两源 **max**（相加会被镜像翻倍，max 不虚增，保守弱信号低估更安全）；只有一源就用该源。
- **dataWindow**：since 取最早、until 取最晚（活动窗口取并集）。
- **subject**：主源为基底，空的 displayName/bio/company/location/email/createdAt/avatarUrl 用辅源非空补；followers/following 取主源（跨源不可加）；`publicRepos` = 融合后 repo 数；profileUrl 取主源。
- **missing**：两源并集去重；**collectedAt**：取较晚。

### FusionReport（随 CLI meta 输出，不持久化进画像）

```ts
interface FusionReport {
  primaryPlatform: SupportedPlatform; secondaryPlatform: SupportedPlatform;
  mergedMirrors: { primaryRef: string; secondaryRef: string; sharedOidCount: number }[];
  suspectedMirrors: { primaryRef: string; secondaryRef: string; reason: 'same_name' }[];
  dedupedCommitCount: number;
  keptSecondaryRepoRefs: string[];
  counts: { primaryRepos: number; secondaryRepos: number; fusedRepos: number;
            primaryCommits: number; secondaryCommits: number; fusedCommits: number };
}
```

## 5. CLI 最小入口

- `analyze <user> --platform all`：分别采集 github、gitee → `fuseInputs` → `analyze(fused, { platform: 'github' })`；输出 JSON 的 `meta.fusion` 带 FusionReport。
- 为可测，`CliDeps` 增加可选 `sources: Partial<Record<SupportedPlatform, {collect(login)}>>` 注入点（优先于单 `deps.source` 与默认 new），测试注入两个 fake source，零网络。
- `--platform all` 仅 `analyze` 支持；`batch` 传 all 直接退出码 2 并提示。

## 6. 测试点

`fusion.test.ts`（analyzer-core，纯函数，重点覆盖）：

1. 共享 oid → strong 镜像：repo 合并、重复 commit 去重、`dedupedCommitCount`/counts 正确。
2. 仅同名无共享 oid → 进 suspected、**两 repo 都保留不并**。
3. 镜像辅源仓里主源没有的 commit → 保留且 repoRef 重映射到主源。
4. 辅源独有仓及其 commit/PR 全保留。
5. 镜像辅源 PR/issue 重映射 repoRef，且融合后每个 commit/pr/issue/repo 引用的 evidenceId 都存在（无悬空）。
6. dataWindow 取并集、subject 空字段补全、contributions 不被辅源虚增、star 取 max。
7. 确定性：同输入两次结果深相等。

CLI：`index.test.ts` 加 `--platform all` 双 fake source 融合出画像、`batch --platform all` 拒绝两个用例。

## 7. 原子提交规划

1. `feat(analyzer)`：新增 fusion.ts + fusion.test.ts，index 导出 fuseInputs/FusionReport。
2. `feat(cli)`：`--platform all` 双源融合入口 + sources 注入点 + CLI 测试。
3. `docs`：本设计文档 + docs/README 场景入口 + handoff（item16）+ deferred #12 标注去重内核已落地（在线融合仍缓做）。

全仓 typecheck/test/build、`git diff --check` 全绿后提交，**不 push**。

## 8. 在线 API/Worker 多源融合（2026-09-16 重启落地）

把 B-5 已验证的 `fuseInputs` 从 CLI 搬到在线链路：用户在报告首页选「GitHub + Gitee（融合）」，一次分析作业同时采两源、镜像去重后产出**一张**画像。复用全部既有纯函数，不改内核、不改 shared 契约、不改规则版本、**不加数据库迁移**。

### 8.1 作业模型与持久化键（关键决策）

- API `POST /analyze` 的 `platform` 由 `github|gitee` 扩为 `github|gitee|all`（默认 github）；`analysis_jobs.subject_platform` 原样存 `'all'`（两方言该列均为无 CHECK 的 text，零迁移）。
- `'all'` 只是**作业/检索维度的虚拟平台键**，不进 shared `PlatformSchema`（仍只有 github/gitee），snapshot 内 `subject.platform` 始终是真实主源。
- Worker 对 `all`：主源固定 **GitHub**（信息更全，与 CLI 一致），`analyze(fused, { platform: 'github' })`，故 `snapshot.subject.platform='github'`，exportable/报告页主体锚点 GitHub，契约合法。
- 融合画像在 `profiles.subject_platform` 列存 **`'all'`**，与单源 github/gitee 画像在缓存/去重维度天然隔离；该列值仅服务端检索与 `GET /profiles|jobs` 的 JSON，报告页 SSR 与扩展 exportable 都读 snapshot，不会看到 `'all'`。

### 8.2 辅源缺失与失败语义

同一 login 在 GitHub 存在、Gitee 无同名账号是常态，必须区分"辅源无账号"与"辅源临时故障"：

| 情况 | 处理 | 画像持久化键 |
| --- | --- | --- |
| 主源 GitHub `not_found` | 上抛，`handleJobFailure` 永久失败（既有逻辑，账号在主源不存在） | — |
| 主源 GitHub 其他错误 | 上抛，按 attempts 重试（既有逻辑） | — |
| 辅源 Gitee `not_found`（404） | **正常降级**：不失败，直接用主源输入分析；`missing` 追加 `gitee:account_not_found` | `'github'`（本质纯 GitHub 画像，不冒充融合） |
| 辅源 Gitee `api_error`/`budget_exhausted`/网络 | **上抛重试**（瞬时错误，不静默用残缺数据冒充融合；3 次后失败） | — |
| 两源都成功 | `fuseInputs(gh, ge, {primary:github, secondary:gitee})` 后分析 | `'all'` |

### 8.3 缓存与去重

- `all` 请求的画像缓存（`latestBySubject`）与 active 去重（`latestActiveBySubject`）都按 `'all'` 维度查询，只认真融合画像，绝不把单源 GitHub 画像误当融合结果返回。
- Gitee-404 降级不形成 `'all'` 缓存：下次 `all` 仍会再试一次 Gitee（成本仅一次轻量 REST），好处是用户后来开通 Gitee 后能自动升级为真融合，无需手动失效。

### 8.4 budget / missing / FusionReport

- `budgetUsed`：两源 Record 同 key 累加（`graphqlPoints` 仅 GitHub 有；`restCalls` 两源相加），反映真实翻倍消耗。
- `missing`：主源原样 + 辅源每项加 `gitee:` 前缀后并集去重；404 降级追加 `gitee:account_not_found`。
- ~~`FusionReport`（镜像数/去重 commit 数）只写 Worker 日志、不持久化~~ **已于 2026-09-17 落地持久化（item23，零迁移）**：`FusionReport` 从 analyzer 内部类型提升为 shared Zod 契约（`MirrorPair/SuspectedMirror/FusionCounts/FusionReport`），`AbilityProfile` 新增**可选** `fusion` 节随不可变画像快照落库（单源画像缺省、旧快照仍可解析），精简投影 `ExportableProfile` 刻意不带；Worker `all` 双源成功时传入、Gitee 404 降级不带，CLI 导出 JSON 同样带；报告页融合画像头部在双源徽标下展示去重统计行（镜像合并仓 / 去重 commit·PR·issue，全 0 或单源不渲染）。

### 8.5 前端与配额

- 报告首页 `AnalyzeForm` 平台切换由 2 项变 3 项，新增 i18n `home.platform.all`（中「GitHub + Gitee（融合）」、英「GitHub + Gitee (fused)」）；`all` 的用户名正则用 Gitee 宽松超集（允许下划线/中划线）；提交 body `platform:'all'`，轮询/跳转逻辑不变。
- demo `touch` 的 `analyzedLogins.platform` 仅接受 github/gitee，`all` 作业记主源 `'github'`。
- 范围限定：融合的用户入口仅**报告首页** `AnalyzeForm`；Chrome 扩展面板自带的平台切换本批保持 github/gitee 两键（扩展主流程是消费画像/一键填充，不在 ATS 域发起双源分析）。API 已接受 `all`，扩展未来需要时无需改后端即可加入口。
- demo 会话分析配额按**作业成本权重**扣减（2026-09-18 拍板落地）：单源 github/gitee 一次作业扣 1；`platform=all` 双源采集约 2x 成本，一次作业扣 **`fusionAnalyzeCost`（默认 2，env `DEMO_FUSION_QUOTA_COST`，positiveInt 最小 1）**。扣减仍走会话级单条条件 UPDATE，WHERE 改为 `analyze_count + cost <= quota`——**剩余额度不足 cost 时整单拒绝（影响 0 行、不部分扣减）**；`jobs.create` 失败的补偿 `releaseAnalyzeSlot(id, cost)` 按原权重回退（MAX/GREATEST 兜底不为负）。IP 速率滑窗仍按请求数计 1（防刷的是请求频次，与成本无关）；Worker demo 并发闸不按 cost（`all` 只是一个 job 占一个并发槽）。零迁移、零 shared 契约改动。

### 8.6 测试点

- Worker：①`all` 双源成功——共享 oid 镜像被去重、画像 `subject_platform='all'`、snapshot 主源 github、budget 两源累加、missing 并集；②Gitee 404 降级——画像 `subject_platform='github'`、`missing` 含 `gitee:account_not_found`、作业 succeeded、不抛错；③Gitee `api_error`——上抛、作业保持 running 可重试。
- API：demo 会话 `POST /analyze {platform:'all'}` 建出 `subject_platform='all'` 的 job；`all` 请求命中 `'all'` 融合画像缓存直接返回。
- 前端：i18n 中英 key 对齐（既有一致性测试守护）+ 真实浏览器点第三按钮确认提交 `all`。单源 github/gitee 路径零回归。

### 8.7 跨源 PR/issue 同帖去重与 7 天窗（2026-09-17 落地 item22；窗口 2026-09-18 拍板锁定）

手动镜像的同一 PR/issue 会在两源各一份，若不处理会被双计。判定刻意保守，沿用镜像"弱判据只报告不合并"的口径：

- **前提**：仅在 `detectMirrors` 已确认的**强镜像配对仓内**才考虑同帖去重；非镜像仓即使标题完全相同也不去重。
- **键空间**：PR 与 issue 分两个独立键空间，**绝不跨类型**（同号/同题的 PR 与 issue 是两回事）。
- **同帖判据（三者全满足）**：同类型 + 标题规范化（trim + 折叠连续空白 + 小写）完全相同 + 创建时间差 ≤ `CROSS_SOURCE_THREAD_WINDOW_MS`。
- **时间窗 2026-09-18 拍板锁定为 7 天**：`CROSS_SOURCE_THREAD_WINDOW_MS = 7*24*60*60*1000`，判据为 `<=`（恰好 7 天仍合并）。镜像同步通常近实时，7 天用于容忍手动镜像/批量导入延迟与两平台时间戳的时区/精度差异；窗外即使标题相同也保守视为两个不同帖（不错并）。常量已 `export`，边界用例「恰好=7 天合并、超 1 秒保留两帖」把阈值钉成契约；**改窗口必须同步本节与回归**。
- **处理**：保留主源版本、丢弃辅源重复帖；辅源原始 evidenceId 收入 `droppedSecondaryEvidenceIds` 并在 evidence 融合段跳过（无悬空证据）；consumed keys 保证一条主源帖最多消一条辅源帖（第二条命中保守保留）。
- `FusionReport` 新增 `dedupedPullRequestCount`/`dedupedIssueCount` 计数（随 item23 的持久化进画像快照 `fusion` 节）。
