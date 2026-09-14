# Gitee 证据源实现设计（design-gitee-source）

- 状态：现行（G-A 本次落地；G-B 缓做，见第 8 节）
- 日期：2026-09-14
- 前置：[design-gitee-source-spike-20260914.md](design-gitee-source-spike-20260914.md)（可行性与差异实测，本设计不重复论证，只给落地方案）
- 关联：`AGENTS.md`「内核与 I/O 分离」、`packages/github-source`（首个 EvidenceSource，本设计对齐其形态）、[design-storage-dual-dialect-20260911.md](design-storage-dual-dialect-20260911.md)

## 1. 目标与范围

把 Gitee Open API v5 作为**第二个 EvidenceSource**，复用同一套分析内核，从 Gitee 账号的公开行为产出 `AnalyzerInput` → `AbilityProfile`。

- **G-A（本次实现，命令行闭环）**
  1. `shared` / `analyzer-core` 做**最小向后兼容适配**：画像 `subject.platform` 支持 `'gitee'`，分析选项可传平台，默认仍为 `'github'`（不改任何真实性/能力规则）。
  2. 新增 `packages/gitee-source`：REST-only 采集器，产出与 github-source 同构的 `{ input, evidence, meta }`。
  3. CLI `analyze` / `batch` 增加 `--platform github|gitee`（默认 github），可在命令行对真实 Gitee 账号出画像（对齐 github「先 CLI 去风险、再服务化」的路径）。
- **G-B（缓做，触发条件见第 8 节）**：worker/api 生产链路选源、跨源镜像去重、events 行为流、Gitee OAuth、认证后精确限频、L2。

> 本次**不改** worker/api/report/extension 的生产采集链路；Gitee 画像先经 CLI 验证内核复用度与信号质量。

## 2. 架构定位

```text
Gitee v5 REST ──► packages/gitee-source（I/O：client/分页/缓存/清洗/mapper）
                        │  产出 AnalyzerInput + EvidenceItem(sourcePlatform='gitee')
                        ▼
              analyzer-core.analyze(input, { profileId, platform:'gitee' })  ◄── 纯内核，规则不改
                        ▼
                   AbilityProfile(subject.platform='gitee')
```

- 内核 `analyzer-core` **不新增任何 I/O、不改信号规则**；唯一改动是让平台标识与一句数据来源 caveat 可参数化（第 5 节）。
- `EvidenceItem.sourcePlatform` 在 shared 本就是开放 `z.string()`（注释已预留 `'gitee'`），证据层无需改类型。

## 3. 端点与请求序列（REST-only）

base：`https://gitee.com/api/v5`；匿名可读公开数据，可选 `GITEE_TOKEN` 提额（用 `Authorization` 头，不放 query、不入日志）。

| 阶段 | 端点 | 用途 |
| --- | --- | --- |
| L0 | `GET /users/{login}` | 账号元数据；404 → `not_found` |
| L0 | `GET /users/{login}/repos?per_page=100&sort=pushed&page=N` | 仓库列表（含其所在组织仓库，按 `owner.login` 判真实 owner；过滤 `fork=true`），`x-total` 翻页 |
| L1 | `GET /repos/{owner}/{repo}/commits?per_page=30&page=1` | 每仓最近提交（仅前 N 个非归档仓） |
| L1 | `GET /repos/{owner}/{repo}/pulls?state=all&per_page=...` | 仓库 PR，**客户端过滤 `user.login===login`（本人发起）** |
| L1 | `GET /repos/{owner}/{repo}/issues?state=all&per_page=...` | 仓库 Issue（Gitee `/issues` 不混 PR），同样按作者过滤 |

- **没有「用户级 PR/Issue 聚合」端点**（GitHub 靠 GraphQL `user.pullRequests`），Gitee 只能遍历仓库再按作者过滤，因此请求数更多。
- 请求预算：L0 最多 `1 + ceil(repos/100)`；L1 对**前 `maxCommitRepos=8` 个非归档仓**各 3 请求。典型 ≈ 2 + 8×3 = **26 次/画像**，低于匿名约 60 次/分钟，默认 `restCalls` 预算 56 留余量。
- 采集顺序与 github-source 一致：L0 失败（账号不存在）直接抛 `not_found`；L1 任一仓/任一类失败只往 `missing[]` 记一条并继续，**禁止输出看似完整的结果**。

## 4. 关键适配规则（mapper，纯函数、可单测）

1. **分页器**：无 RFC5988 `Link`，用 `page/per_page` + 响应头 `x-total` 算末页；并以「返回空数组或不足一页」为兜底终止（events 类端点会忽略 per_page，本版不取 events，但分页器统一按兜底写）。
2. **时区归一**：Gitee 时间带 `+08:00` 偏移，统一 `new Date(s).toISOString()` 转 UTC Z；无法解析得 `null`，不伪造。
3. **PII 出口清洗（硬边界）**：`commit.commit.author.email/name` 明文（甚至手机号形态邮箱）**一律不进 AnalyzerInput/evidence/画像**：`AnalyzerCommit.authorEmail=null`；`authorName` 只取顶层公开 `author.login`（登录名非个人姓名），缺失为 null。`subject.email` 同样置 null（不调用任何返回邮箱的端点）。
4. **PR 缺增删行**：Gitee PR 无 additions/deletions/changed_files，`AnalyzerPullRequest` 三字段填 `0`，并记一条 `missing:'pr_code_stats'`（内核生产代码本就不消费这三字段，仅类型保留）。
5. **PR state 映射**：`open→OPEN`、`merged→MERGED`（或 `merged_at` 非空）、`closed→CLOSED`；`repoOwnerIsSelf = repo.owner.login===login`。
6. **Issue 标识**：Gitee issue 标识可能是区分大小写字符串（`ident`，实测见 spike）。`AnalyzerIssue.number` 为 number：能 `Number()` 成有限整数则用整数，否则回退为其在本次列表中的 1 基序号（仅保证本次采集内 evidence 引用唯一），原始 `ident` 体现在 `url` 与 evidence `rawRef`。
7. **contributions 自行聚合**（Gitee 无 contributionCalendar）：`totalCommitContributions=commits.length`、`totalPullRequestContributions=pullRequests.length`、`totalIssueContributions=issues.length`、`totalRepositoryContributions=repos.length`；`contributionMonths` 由 commits 的 `committedAt` 按 `YYYY-MM` 聚合。口径是「采样窗口」而非 GitHub 的「过去一年精确值」，在 caveat 中说明。
8. **dataWindow**：`since=user.created_at(UTC)`；`until=max(各 repo.pushed_at, 各 commit.committedAt)`，全空则回退 `since`。
9. **仓库归属**：保留组织仓库（行为证据可能在内），但 `ownerLogin` 取 `repo.owner.login`；`fork=true` 排除、`archived=true` 不参与 L1 提交采集（与 github 一致）。
10. **证据 URL/平台**：evidence 的 `sourcePlatform='gitee'`，URL 指向 `https://gitee.com/...`，evidenceId 前缀沿用 `user:/repo:/commit:/pr:/issue:`（id 内已含 owner/name 与平台无关，跨源不撞，因为同一 AnalyzerInput 只来自单一源）。

## 5. 内核与 shared 的最小改动（向后兼容）

- `packages/shared`：`AbilityProfileSchema.subject.platform` 与 `ExportableProfileSchema.subject.platform` 由 `z.literal('github')` 放宽为 `z.enum(['github','gitee'])`；导出 `SUPPORTED_PLATFORMS`。
- `analyzer-core/profile.ts`：`AnalyzeOptions` 增加可选 `platform?: 'github' | 'gitee'`（默认 `'github'`）；`subject.platform` 取该值；「Public GitHub data only…」caveat 按平台切换为 Gitee 对应表述，另对 Gitee 增加一条「贡献计数为采样窗口值」说明。**信号/标签/活动/面试题规则零改动**。
- 既有调用（worker/api/cli github 路径、全部既有测试）不传 platform，行为完全不变。

## 6. 新包文件清单（packages/gitee-source）

```text
packages/gitee-source/
├─ package.json            # @jobagent/gitee-source，依赖 analyzer-core/shared；无 octokit
├─ tsconfig.json / tsconfig.build.json   # 照抄 github-source
└─ src/
   ├─ types.ts             # GiteeCollectedData/GiteeSourceOptions + v5 原始响应接口
   ├─ client.ts            # 原生 fetch（可注入）：超时/有限重试/429 退避、x-total 分页、弱 ETag(If-None-Match→304)、请求预算、剩余额度读取
   ├─ mappers.ts           # 纯函数：v5 行 → AnalyzerSubject/Repo/Commit/PR/Issue（含第 4 节全部规则）+ aggregateCommitMonths/buildDataWindow
   ├─ evidence.ts          # 五类 EvidenceItem（sourcePlatform='gitee'）
   ├─ collector.ts         # GiteeSource：collectL0/collectL1/collect + GiteeSourceError(not_found/api_error/budget_exhausted)
   ├─ index.ts             # 对外导出
   └─ *.test.ts            # 确定性单测（第 7 节）
```

对外形态对齐 github-source：

```ts
const src = new GiteeSource({ token?: process.env.GITEE_TOKEN, fetch?, log?, budget? });
const { input, evidence, meta }: GiteeCollectedData = await src.collect(login);
const profile = analyze(input, { profileId, platform: 'gitee' });
```

## 7. 测试策略（默认确定性，不打真实网络）

- client 注入 `fetch` fake：分页（x-total 多页 + 空页兜底）、304 命中缓存、429 退避后成功、预算耗尽抛 `budget_exhausted`、404→`not_found`。
- mappers：时区转 UTC、**PII 邮箱/姓名被剥离**、PR 增删行填 0 与 state 映射、issue 字符串 ident 回退、fork/archived 过滤、PR/Issue 按作者过滤、contributions 与 dataWindow 聚合。
- collector：用**录制并脱敏的 Gitee 响应夹具**（录制时同步抹邮箱）跑完整 collect，断言产出合法 `AnalyzerInput`、evidence 全部 `sourcePlatform='gitee'` 且 evidenceRefs 可回溯、L1 局部失败进 `missing` 且不中断。
- shared/analyzer：schema 接受 `platform:'gitee'`、`analyze(...,{platform:'gitee'})` 画像 subject/caveat 正确；默认 github 的既有断言保持不变。
- CLI：`--platform gitee` 选择 GiteeSource、向 analyze 透传 platform（注入 fake source）；缺 `--platform` 仍走 GitHub 且要求 GITHUB_TOKEN。

## 8. G-B 缓做项与触发条件（登记 deferred）

| 缓做项 | 触发条件 |
| --- | --- |
| worker/api 生产链路选源（POST /analyze 带 platform、DB 存 subject.platform、report/extension 展示平台标识） | G-A 经 CLI 在 ≥10 个真实 Gitee 账号上验证信号质量后 |
| `events/public` 行为流补充 | 仅 commits/PR/Issue 的时序被证明不足以判活时 |
| 跨源 GitHub/Gitee 镜像项目去重、多源融合画像 | 进入多证据源融合里程碑 |
| Gitee OAuth / 私人令牌提额与最小权限、私有仓库 | 出现需要分析私有 Gitee 数据的真实需求 |
| 认证后精确限频额度/窗口核实 | 启用 token 提额前（查官方 oauth_doc/限频页） |

## 9. 非目标

- 不做 L2 clone/diff 内容分析；不做全自动后台投递；不引入 GraphQL（Gitee 无公开端点）；不依赖匿名全站搜索（`/search/repositories` 匿名返回空，只按已知 login 列举）；本版不接生产 Web 链路。
