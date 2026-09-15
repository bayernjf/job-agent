# 跨源镜像去重与最小双源融合设计（B-5）

> 日期：2026-09-15　状态：现行　范围：新增 `packages/analyzer-core` 纯函数 + CLI 最小入口；**不改在线 API/Worker 单源链路、不改 shared 契约、不改规则版本**。
> 关联：deferred #12 剩余缓做项「跨源 GitHub/Gitee 镜像项目去重、多源融合画像」；本文落地其中的**去重内核 + 最小融合预处理**，在线多源融合仍按触发条件缓做。

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

- **不做在线 API/Worker 多源融合**（一个 job 采两源涉及成本翻倍、作业模型、持久化与 subject 合并的产品决策，仍按 deferred #12「多源融合进入排期」重启）。
- 不新增 shared `PlatformSchema` 枚举值（融合画像 `options.platform` 取主源 `github`）；不改 `AbilityProfile`/`AnalyzerInput` 字段结构；融合报告只随 CLI `meta` 输出，不进持久化画像。
- 不做跨源 PR/Issue 的"同帖去重"（两平台编号空间不同、无法可靠判定 Gitee issue 是否从 GitHub 同步，保守保留为真实跨平台活动）。
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
