# Gitee 证据源 Spike（设计结论）

- 状态：现行（spike 已完成；**不包含实现**）
- 日期：2026-09-14
- 关联：`AGENTS.md`「内核与 I/O 分离」（github-source 是首个 EvidenceSource，未来同接口新增源）、`docs/design-job-ingestion-20260913.md`、`docs/deferred-items.md`
- 要回答的问题：**Gitee Open API v5 能否作为第二个 EvidenceSource，支撑我们 L0 元数据 + L1 行为时序的采集？与 GitHub/Octokit 有哪些必须处理的差异、成本与风险？**

> 本 spike 只验证可行性并沉淀适配设计，不新增 `packages/gitee-source`、不写采集代码。是否实现属于待决策事项（见末章与 deferred-items）。

## 1. 结论摘要（TL;DR）

| 维度 | 结论 |
| --- | --- |
| 总体可行性 | **技术可行**：L0 元数据充分；L1 行为时序基本可行（commits + events 足够），但协作/代码量信号弱于 GitHub |
| 协议 | **仅 REST，无公开 GraphQL**（`POST /api/v5/graphql` 实测 404）；v5 URL 风格刻意对齐 GitHub REST |
| 匿名可读 | 公开仓库/用户匿名可读，国内直连无需代理（实测单请求约 0.5s） |
| 限频 | 响应头 `x-ratelimit-limit=60`，社区资料为约 **60 次/分钟**，超限 429；认证提额（精确值待官方文档核实） |
| 缓存 | 支持弱 ETag（`W/"…"`）+ `If-None-Match` → **304**；无 `Last-Modified` |
| 分页 | **无 RFC5988 `Link` 头**，用 `page/per_page`（默认 20、最大 100）+ `x-total` 总数头自行翻页 |
| 最大差异 | Issue 编号是**区分大小写的字符串**、PR 编号是整数；`/issues` 不混 PR；PR 无增删行统计；commit 作者邮箱**明文不脱敏**（PII） |
| 对内核影响 | **`analyzer-core` 不改**；`EvidenceItem.sourcePlatform='gitee'` 类型早已预留；未来仅新增一个 source 包 |
| 建议 | M1/P1 不实现；触发条件满足后按第 5 章设计新增 `packages/gitee-source` |

## 2. 实测方法与样本

- 网络：国内直连 `https://gitee.com/api/v5`，不走代理；全部匿名、无 token。
- 仓库样本：确定存在的组织仓库 `mindspore/mindspore`（不凭记忆猜用户名）。
- 真实个人 login 从该仓库 commits 列表**现取**得到 `yao-xiaobai`，再用它测用户类端点（避免猜用户名导致 404 的既有教训）。
- 方式：一次性 Node `fetch` 探测脚本（用后即删，未入库），逐端点记录 HTTP 状态、关键字段、限频响应头与耗时；另用公开资料交叉验证限频/认证/分页约定。
- 下文标注「实测」=本次真实请求所见；「文档」=官方/SDK 文档或社区资料；「待核实」=实现前必须再确认。

## 3. 端点 ↔ L0/L1 需求映射（实测）

| 我们的采集需求（对标 github-source） | Gitee v5 端点 | 状态 | 关键字段 / 备注 |
| --- | --- | --- | --- |
| L0 用户档案 | `GET /users/{login}` | ✅ 200 | login、name、public_repos、followers、created_at、company、blog |
| L0 仓库列表 | `GET /users/{login}/repos` | ✅ 200 | 数组；**注意会带出其所在组织的仓库**，"所有权"要用 owner/权限字段判定，不能直接当作个人项目 |
| L0 仓库元数据 | `GET /repos/{owner}/{repo}` | ✅ 200 | stargazers_count、forks_count、language、open_issues_count、pushed_at、created_at、default_branch、license、owner |
| L1 提交时序 | `GET /repos/{owner}/{repo}/commits` | ✅ 200 | sha、`commit.author{name,email,date}`、`commit.message`、`parents`、**顶层 `author.login`**；`x-total` 给提交总数（样本 101501） |
| L1 行为流 | `GET /users/{login}/events/public` | ✅ 200 | PushEvent / CreateEvent + created_at，可拼行为时间线；**实测 `per_page=5` 被忽略、返回 20 条** |
| L1 PR 列表/详情 | `GET /repos/{o}/{r}/pulls`、`/pulls/{number}` | ⚠️ 200 但偏弱 | number（**整数序数**）、state、title、user.login、created_at、merged_at、mergeable、draft、head/base、diff_url；**无 additions/deletions/changed_files/commits 计数** |
| L1 Issue | `GET /repos/{o}/{r}/issues`、`/issues/{number}` | ⚠️ 模型不同 | **number 为区分大小写的字符串**（实测 `"IDLSUI"`），`/issues` **不混入 PR**；有 comments、state、created_at |
| 全站仓库搜索 | `GET /search/repositories?q=…` | ⚠️ 匿名受限 | 匿名 `q=vue` 返回 200 但体为 `[]`；我们按已知 username 列举，**不依赖此端点** |
| GraphQL 聚合 | `POST /api/v5/graphql` | ❌ 404 | 返回 HTML 404 页，**无公开 GraphQL**（Gitee Team 企业版是另一套 API，不等同） |

## 4. 与 GitHub / Octokit 的关键差异（实现时必须处理）

1. **REST-only，没有 GraphQL 批量聚合**。GitHub 侧我们用一次 GraphQL 聚合拿多类数据，Gitee 必须按资源扇出多个 REST 请求 → 请求数更多，恰好撞上更紧的限频，因此**单画像调用预算 + 缓存 + 退避比 GitHub 侧更重要**。
2. **限频模型不同**。匿名响应头 `x-ratelimit-limit=60`、每请求 `remaining` 递减；社区资料为约 60 次/分钟、超限 429（GitHub 匿名是 60/小时，口径不同）。响应头**没有 reset 窗口字段**。认证（私人令牌/OAuth）后额度与窗口的精确值「待核实」。
3. **认证方式与令牌风险**。v5 对齐 GitHub REST，支持私人令牌 `access_token`（query 或 Authorization 头）与 OAuth2（`/api/v5/oauth_doc`）。社区资料指出 Gitee 令牌**权限粒度较粗、默认关联账户全部权限**——更要坚持服务端保管、最小暴露、不入库不入前端（与现有密钥约束一致且更严格）。
4. **Issue / PR 标识模型不同**。Issue 编号是可含字母、区分大小写的**字符串**，PR 编号是**整数**，且 `/issues` 不像 GitHub 那样混入 PR。`rawRef`/主键建模必须区分二者，不能套用 GitHub "number 即整数、issues 里过滤 PR" 的假设。
5. **PR 缺代码量统计**。单 PR 详情实测字段中没有 additions/deletions/changed_files/commits 计数，只能另取 `diff_url/patch_url` 或 `commits_url`。因此 analyzer 里依赖"增删行/改动文件数"的信号在 Gitee 上要**降级或换算法**。
6. **提交作者 PII**。commits 的 `commit.author.email/name` 是**明文且不做 noreply 脱敏**（样本中甚至出现手机号形态邮箱），而顶层另有 `author.login`。**采集层必须剥离邮箱/姓名明文，只保留 login 与时间**；邮箱/手机号禁止进入 evidence、画像快照与任何前端响应。
7. **分页机制不同**。没有 GitHub 的 `Link: rel="next"`，要靠 `page/per_page` + 响应头 `x-total`（总数）自己算页数；且个别端点（events）实测不严格遵循 `per_page`，翻页要以"返回为空/不足一页"为终止条件，不能只信 per_page。
8. **时间带本地时区偏移**。如 `pushed_at=2026-01-24T10:39:38+08:00`，入库/比较前统一转 UTC ISO，避免与 GitHub 的 Z 时间混用时序错乱。
9. **双平台镜像仓库**。不少组织（如 mindspore）同一项目在 GitHub 与 Gitee 双开，Gitee 上 PR 活跃度可能很低（实测 `state=all` 列表头部是 2020 年旧 PR）。跨源融合时要做项目去重，不能把镜像当两份独立贡献重复计分。
10. **缓存可行但只有 ETag**。弱 ETag + `If-None-Match` 实测返回 304 空体，可沿用"ETag 条件请求 + 缓存优先"；没有 `Last-Modified`，不要实现 `If-Modified-Since` 路径。
11. **官方 schema 并非完全可靠**。社区 SDK 明确指出 Gitee 官方 swagger 存在错误，**字段以真实响应为准**，适配层要对缺字段健壮（与我们"证据不足显式标注、不输出看似完整结果"的原则一致）。

## 5. 未来实现设计建议（本次不落地）

架构上 `analyzer-core` 是纯内核、`github-source` 只是第一个 `EvidenceSource`，新增 Gitee **不需要改内核**，只新增一个 I/O 包：

- 新增 `packages/gitee-source`（命名与 github-source 对齐），对外实现与 github-source 一致的 EvidenceSource 接口，输出统一 `EvidenceItem`（`sourcePlatform: 'gitee'`，该字段与枚举早已在 `packages/shared` 预留）。
- **REST-only 采集器**：按 username 扇出 user → repos → 每仓 commits / pulls / issues + events/public；内置单画像请求预算，读 `x-ratelimit-remaining` 做退避。
- **分页器**：基于 `x-total` + `page/per_page`，以空页/不足页兜底终止，不依赖 Link 头。
- **缓存**：弱 ETag 条件请求，命中 304 复用本地精简快照（与 GitHub 侧 ETag 策略一致）。
- **PII 清洗边界放在 source 包出口**：剥离 `commit.author.email/name`，只输出 login、时间、sha、message、url 指针。
- **标识与时区归一**：issue 字符串编号 / PR 整数编号分类型存 rawRef；所有时间转 UTC。
- **信号适配在 analyzer 侧以规则版本化方式处理**：对 Gitee 关闭/降级依赖增删行的信号，改用提交节奏、多仓库、events 活跃度、issue/PR 时序等可得信号；规则集按 source 分支并升版本。
- **不使用匿名全站搜索**；用户/仓库发现一律走"已知 login → 列举"。
- 测试沿用项目确定性原则：录制并脱敏 Gitee 响应为夹具（**录制时同步抹掉邮箱**），单测不打真实网络。

## 6. L0 / L1 支撑度评估

- **L0 元数据：充分**。用户档案、仓库列表、仓库元数据全部匿名可得，足以支撑账号存在性、主语言、star/fork、活跃时间窗等。
- **L1 行为时序：基本可行**。commits（作者、时间、消息、父子关系）+ events/public（Push/Create 流）能重建行为节奏与连续性；协作信号（PR/Issue）可得但偏浅——无增删行、issue 标识为字符串、镜像组织活跃度低，相关真实性/能力信号需谨慎降权。
- **不支持的深度**：L2 及以上（clone、diff 内容级分析）本就不在 MVP 范围，Gitee 同样不做。

## 7. 风险与待核实清单（实现前关闭）

- 认证后精确限频额度/窗口、OAuth scope 与令牌最小权限组合（查官方 oauth_doc / 限频说明页）。
- events/public 的历史保留期、`per_page` 异常行为的稳定边界。
- 企业版 / 私有仓库字段差异（MVP 只分析公开数据，默认不涉及）。
- 双平台镜像项目的跨源去重规则（与未来多源融合一起设计）。
- Gitee API 稳定性与官方 schema 错误清单，以录制夹具锁定真实形状。

## 8. 决策建议（供拍板，不自行实现）

spike 结论是"**可行但有明确适配成本**"。建议 M1/P1 阶段维持 GitHub 单源、不实现 gitee-source；当出现明确触发条件（如目标用户中国内平台占比上升、用户显式要求分析 Gitee、或开始做多源融合）时，再按第 5 章新增 source 包。对应缓做条目已登记到 `docs/deferred-items.md`（带触发条件）。
