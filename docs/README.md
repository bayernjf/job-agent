# JobAgent 文档地图

> **场景导航 + 文档状态约定**。完整文档清单（每个文档一句话定位）的单一事实源是 [../handoff.md](../handoff.md) 的「Project documents」区——本文档不重复维护清单，只回答「我想做某事该看哪个」。与 `agent-world` 的文档分层惯例对齐。

## 怎么读这个仓库（按场景）

| 我想… | 看 |
| --- | --- |
| 知道现在做到哪、接下来做什么 | [../handoff.md](../handoff.md) ★ 交接必读 |
| 理解产品初衷、要解决的根本问题 | [产品构想-以GitHub为桥梁的招聘系统.md](产品构想-以GitHub为桥梁的招聘系统.md) |
| 看产品范围、功能 F1–F9、画像契约、指标与风险 | [PRD.md](PRD.md) ★ |
| 回看"为什么从分析 GitHub 切入、MVP 如何收敛"的讨论过程 | [讨论记录-01-切入口与MVP收敛-20260910.md](讨论记录-01-切入口与MVP收敛-20260910.md) |
| 了解投递功能方向、Jobright 竞品深度分析、四种技术路径对比 | [讨论记录-02-投递功能与竞品分析-20260911.md](讨论记录-02-投递功能与竞品分析-20260911.md) |
| 看技术栈选型、运行架构、目录规划、M1 排期与 Spike | [技术选型-MVP-20260910.md](技术选型-MVP-20260910.md) |
| 逐条看待拍板事项与建议组合 | [待拍板决策清单-20260910.md](待拍板决策清单-20260910.md)（#1–#8 已拍板，#9–#14 延后） |
| 看哪些事被刻意缓做、什么条件下重启 | [deferred-items.md](deferred-items.md) |
| 接手写代码 / 了解工程硬约束 | [../AGENTS.md](../AGENTS.md) + [../CONTRIBUTING.md](../CONTRIBUTING.md) |
| 新增 / 修改数据库结构 | [../MIGRATION_CONVENTION.md](../MIGRATION_CONVENTION.md) |
| 写提交信息 / 走分支与 PR 流程 | [../git-commit-message.md](../git-commit-message.md) + [../PULL_REQUEST_WORKFLOW.md](../PULL_REQUEST_WORKFLOW.md) |
| 看 AI 求职赛道的竞品认知、机会与跟进清单 | [市场调研-AI求职赛道-20260910.md](市场调研-AI求职赛道-20260910.md) |
| 写用户可见文案 / 加双语 / 处理语言与分享链接（含扩展面板、MV3 _locales） | [design-i18n-20260910.md](design-i18n-20260910.md) ★ |
| 定颜色、间距、圆角、字号 / 改主题（共享 token 包、Shadow DOM 接入） | [design-tokens-20260910.md](design-tokens-20260910.md) ★ |
| 让存储层同时支持 SQLite 与 Postgres / 新增数据库方言 | [design-storage-dual-dialect-20260911.md](design-storage-dual-dialect-20260911.md) ★ |
| 看 P2 职位聚合的数据源结论、最小链路设计与推荐组合 | [设计-职位聚合-Spike-20260913.md](设计-职位聚合-Spike-20260913.md) ★ |
| 写 P2 岗位采集管道代码（job_postings 建表 / 各源适配器 / 调度去重 / 分期） | [design-job-ingestion-20260913.md](design-job-ingestion-20260913.md) ★ |
| 评估 / 未来新增 Gitee 证据源（v5 可行性、与 GitHub 差异、L0/L1 支撑度） | [design-gitee-source-spike-20260914.md](design-gitee-source-spike-20260914.md) ★ |
| 写 Gitee 第二证据源代码（v5 REST 采集 / AnalyzerInput 映射 / PII 清洗 / CLI --platform 选源） | [design-gitee-source-20260914.md](design-gitee-source-20260914.md) ★ |
| 改扩展面板的岗位匹配展示（top5 列表/匹配依据/证据外链/四态/i18n） | [design-extension-match-ui-20260914.md](design-extension-match-ui-20260914.md) ★ |
| 给扩展写浏览器级 E2E（加载 MV3 / content script 注入 / 面板渲染回归） | [design-extension-e2e-20260914.md](design-extension-e2e-20260914.md) ★ |
| 装 / 试用浏览器扩展，一键填充 ATS 表单 | [../apps/extension/README.md](../apps/extension/README.md) |
| 快速了解项目门面与技术栈 | [../README.md](../README.md) |

## 文档分层约定（重要）

- **[../handoff.md](../handoff.md)**：管"正在做"——当前状态、活跃待办、最近变更、以及全部文档的索引（清单的单一事实源）；**只写状态与结论，明细一律放本目录对应文档并在 handoff 给链接**。
- **`docs/`（本目录）**：管"设计与结论全文"——一个主题一份文档，不重复记实施进度。
- **[deferred-items.md](deferred-items.md)**：管"挂着没做"——每条缓做事项必须写明**触发条件**；触发后移回 handoff 待办并标注重启日期。
- **新增任何文档后**：在 handoff 的「Project documents」登记一行（含一句话定位），并在本导航表补一行场景入口。

## 文档状态约定

- **现行**：当前事实，以此为准；事实变化直接更新。
- **历史**：决策/讨论过程记录，结论已体现在现行文档；要改结论应改现行文档而非历史记录（如「讨论记录」「产品构想」）。
- **归档**：冻结只读，不再追加。
- **实施进度**：统一记在 [../handoff.md](../handoff.md)，设计文档只写设计，不重复记流水进度。
- **完整清单**：所有文档（含一句话定位）见 handoff「Project documents」区——新增文档先在那里登记。
