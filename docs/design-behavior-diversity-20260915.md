# 设计：行为多样性信号（方案 B，B-1 采集备料 + B-2 内核信号）

> 状态：**现行（2026-09-15 落地，规则版本 0.1 → 0.2）**
> 关联：[design-gitee-source-20260914](design-gitee-source-20260914.md) §4.11（events 行为流，方案 A）、[deferred-items #12](deferred-items.md)、[PRD 第 8 章](PRD.md)
> 上游事实：Gitee events 实测见 design-gitee-source §4.11；GitHub public events 为官方 REST（`GET /users/{username}/events/public`，per_page≤100、最多 10 页/近 90 天）。

## 1. 背景与目标

方案 A（已落地）只在 **gitee-source 层**用 events 补近期 commit，解决"活跃用户被采样窗口误判薄证据"，但**没有动 analyzer 内核**。方案 B 进一步回答一个现有规则覆盖不到的反模式：**行为高度集中在单一仓库、且缺乏协作痕迹**（典型如在一个仓集中刷提交、伪造活跃度）。

拆成两档，本次一起做：

- **B-1 采集备料**：各证据源把 public events 聚合成源无关的 `BehaviorEventSummary`（跨仓广度、事件类型分布），随 `AnalyzerInput` 传入；不单独产出结论。
- **B-2 内核信号**：analyzer-core 新增一条**保守的弱信号** `narrow_activity_scope`，结合"结构化行为（commits/PR/issues）+ 事件流概览"判断，**升规则版本到 0.2**。

硬约束（与既有架构一致）：

- analyzer-core 仍是**纯函数、无 I/O、规则版本化**；事件类型→"协作型"的判定规则只在内核，source 只提供事实计数。
- 新字段**可选**：历史快照、端点失败、旧夹具都可能没有 `behaviorEvents`，此时信号走"结构化降级"，绝不能因为缺字段就判负。
- 新信号**封顶 `warn`（人工复核），不产生 `risk`**：单仓专注的独立开发者是正常形态，只有多条件叠加才提示，且被"外部 merged PR"直接豁免。

## 2. 契约：`BehaviorEventSummary`（analyzer-core/input.ts）

`AnalyzerInput` 新增**可选**字段（不破坏 AbilityProfile 输出 schema，故 `SCHEMA_VERSION` 不升，只升 `RULE_VERSION`）：

```ts
export interface BehaviorEventSummary {
  /** 采集到的事件条数（GitHub 取第 1 页 ≤100；Gitee 固定最近 20） */
  totalEvents: number;
  /** 事件涉及的不同 owner/name 仓库数（跨仓活动广度） */
  distinctRepoCount: number;
  /** 各事件类型 → 条数（行为多样性事实，如 {PushEvent:12,PullRequestEvent:3}） */
  eventTypeCounts: Record<string, number>;
  /** 事件时间窗（可空：无有效 created_at） */
  since?: string;
  until?: string;
}
// AnalyzerInput 增加：behaviorEvents?: BehaviorEventSummary;
```

设计要点：

- 只传**聚合摘要**、不传原始事件数组：内核只需要可计算信号的最小事实；两源事件窗口都不完整（Gitee 仅 20 条、GitHub 近 90 天），原始数组样本不稳，聚合更稳。
- "哪些事件类型算协作型"是**分析规则**，不放 source：内核用 `/PullRequest|Issue|Review|Comment/i` 匹配 type 得 `collaborativeEventCount`，规则随内核版本化、可单测。

## 3. 内核信号：`narrow_activity_scope`（rules.ts / signals.ts / activity.ts）

### 3.1 规则版本与信号码

- `RULE_VERSION`: `0.1` → `0.2`；`analyzerVersion` 由 `${SCHEMA_VERSION}-${RULE_VERSION}` 自动变为 `0.1-0.2`。
- **既有信号码保留 `r0.1.*` 前缀**（其逻辑未变，避免大面积快照漂移）；**新信号用 `r0.2` 前缀**：

```ts
NARROW_ACTIVITY_SCOPE: 'r0.2.sig.narrow_activity_scope',
```

### 3.2 触发与豁免逻辑（保守、可解释）

先算**结构化狭窄候选**（任何源都能算，不依赖 events）：

- `behaviorTotal = commits + pullRequests + issues`
- `commitRepoCount` = commits 涉及的不同 repo 数；`top1Share` = 提交最多仓的 commit 占比
- `externalMerged` = 非本人仓且 MERGED 的 PR 数；`prCount` = pullRequests 数

`structurallyNarrow` 需**同时**满足：

1. `behaviorTotal >= 30`（行为量足够才评判，小样本不误伤）；
2. 提交高度集中：`commitRepoCount <= 1` 或 `top1Share >= 0.9`；
3. 协作匮乏：`externalMerged === 0` 且 `prCount < 3`。

再用事件流做**反向豁免**（events 的核心价值是发现"采样 top 仓之外"的活动）：

- 若 `behaviorEvents` 存在，且 `distinctRepoCount >= 2` **或** `collaborativeEventCount > 0` → 说明事件流证明其在多仓活动 / 有 PR·Issue·Review·Comment 等协作，结构化的"单仓"是采样偏差，**不发信号**；
- 若 `behaviorEvents` 缺失（undefined）→ 无法反证，`structurallyNarrow` 成立即发 `warn`（结构化降级）；
- 若 `behaviorEvents` 存在但同样狭窄（单仓、零协作型事件）→ 相互印证，发 `warn`。

信号形态：`severity: 'warn'`，label `Activity concentrated in a single repository with little collaboration`，detail 给出 top1 仓占比、PR 数、事件类型种类；`evidenceRefs` 引用该仓 `repo:` 证据（经 `validRefs` 过滤，无证据不下结论）。

### 3.3 阈值依据（对齐既有校准）

- `behaviorTotal >= 30`：与 star_to_commit 的 `behaviorHere >= 150`、thinEvidence 的 `< 60` 同量级取中，保证只在行为量不小的时候评判；
- `top1Share >= 0.9`：对齐 `self_pr_ratio` 的 0.9 高占比风格；
- `prCount < 3`：对齐 external contributions "1-2 弱、3+ 强" 的分界，少于 3 个 PR 才视为协作薄弱；
- 不升 risk、且 external merged 直接豁免，延续 2026-09-11 负样本校准"难以伪造的协作证据优先"的原则。

### 3.4 activity.metrics 增补（B-1 可见化）

`computeActivity` 的 `metrics` 增加（都是 number，不破坏 schema）：

- `commitRepoCount`：提交涉及的不同仓数（任何源可算）；
- 仅当 `input.behaviorEvents` 存在时再加 `eventTotalEvents`、`eventDistinctRepos`、`eventTypeKinds`（事件类型种类数）。

## 4. 双源采集

### 4.1 Gitee（gitee-source，复用方案 A 已拉的 events）

- 新增纯函数 `summarizeGiteeEvents(events, login): BehaviorEventSummary | null`（mappers.ts）：只统计 **actor 为本人**的事件（与 `mapEventsToCommits` 同口径），`distinctRepoCount` 用 `repo.full_name/human_name` 去重，`eventTypeCounts` 统计非空 type，时间窗由 `created_at`（+08:00→UTC）min/max 得到；无有效事件返回 null。
- collector 在已有 events 拉取处调用，填入 `input.behaviorEvents`（null 则不带该字段）。**不新增请求**（复用方案 A 那次 events 调用）。

### 4.2 GitHub（github-source，新增单次 public events REST）

- rest.ts 新增 `fetchPublicEventsRest(octokit, login)`：`GET /users/{username}/events/public`，**只取第 1 页、per_page=100**（只需多样性概览，不深翻；与 Gitee"只取一次"哲学一致），REST 预算 **+1**。
- 新增 `summarizeGhEvents(rows): BehaviorEventSummary | null`：GitHub `repo.name` 已是 `owner/repo`、`created_at` 为 UTC Z，其余口径与 Gitee 一致。
- collector 在 `collect()` 中 try/catch 调用：失败只 `missing.push('events')` + warn，不阻塞 L0/L1；成功填 `input.behaviorEvents`。

### 4.3 缺失降级矩阵

| 场景 | behaviorEvents | 结果 |
| --- | --- | --- |
| 事件流显示多仓 / 有协作事件 | 有，且反证 | 豁免，不发信号 |
| 事件流也单仓、零协作 | 有，且印证 | 发 warn |
| events 端点失败 / 历史快照 / 旧夹具 | 无 | 仅按结构化条件判定（可能 warn，绝不因缺字段直接判负） |
| 行为量小（<30）/ 跨仓 / 有外部 merged PR / PR≥3 | 任意 | 不发信号 |

## 5. 测试与校准

- **analyzer-core**：signals.test 新增用例——①单仓大量 commit+0 PR+事件流仅 PushEvent→warn；②事件流显示多仓或协作事件→豁免；③外部 merged PR→豁免；④behaviorTotal<30 不触发；⑤behaviorEvents 缺失时的结构化降级；⑥evidenceRefs 全部真实存在。activity 增补 metrics 断言。
- **gitee-source**：mappers.test 加 `summarizeGiteeEvents`（本人过滤/类型计数/仓去重/时间窗/空→null）；collector.test 验证 `input.behaviorEvents` 填充与 events 失败时缺省。
- **github-source**：rest.test 加 `summarizeGhEvents`；collector.test 加 events 成功填充、失败记 `missing:'events'`、REST 预算 +1。
- **现有校准用例零回归走查**（已逐条核对 signals.test）：默认强账号（跨 2 仓 + 外部 merged PR）、burst、wycats（284 单仓但 47 self PR≥3）、ByteBunny（有外部 PR）、self_pr_ratio、near-empty 等均**不触发**新信号；MSNightmare（33 单仓、0 PR、behaviorTotal≥30）会**额外叠加**一个 warn，但其 status 本就因 risk 为 suspicious、相关断言不涉及信号总数，故不破坏。
- **真实 26 账号双源回归**：仓内无常驻账号数据集（阈值固化在 signals 注释），重跑需 GITHUB_TOKEN/GITEE_TOKEN 与网络，本次不做，列为 handoff 待办（拿到 token 后用 CLI 批量跑、确认新信号不误伤真实活跃账号，再微调阈值）。

## 6. 边界（本次不做）

- 不做事件级时间序列 / 行为节奏聚类（只取聚合摘要）；
- 不把新信号升为 risk、不引入"行为多样性正向加分"（避免动 confidence 基线过多）；
- GitHub events 不深翻（只第 1 页），Gitee 受平台限制仍是最近 20 条；
- 不改 SCHEMA_VERSION / AbilityProfile 输出结构、不改存储迁移（behaviorEvents 是输入侧字段，不入库）。

## 7. 改动清单与提交规划

- `packages/analyzer-core`：input.ts（契约）、rules.ts（版本+信号码）、signals.ts（信号+豁免）、activity.ts（metrics）、index.ts（导出类型）+ 测试。
- `packages/gitee-source`：mappers.ts（summarize）、collector.ts（接线）、index.ts（导出）+ 测试。
- `packages/github-source`：rest.ts（fetch+summarize）、collector.ts（接线+预算）、index.ts（导出）+ 测试。
- 文档：本设计、design-gitee-source §4.11 加指针、deferred #12、handoff、docs/README、AGENTS（如需要）。
- 原子提交：① `feat(analyzer)` 内核契约+信号+测试；② `feat(gitee)` Gitee 聚合接线+测试；③ `feat(github)` GitHub events REST+聚合+测试；④ `docs` 设计与追踪同步。每提交过 husky 全仓 typecheck；交付前全仓 typecheck/test/build + check-migrations + git diff --check。
