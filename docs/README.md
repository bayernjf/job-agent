# JobAgent 文档地图

> **场景导航 + 文档状态约定**。完整文档清单（每个文档一句话定位）的单一事实源是 [../handoff.md](../handoff.md) 的「Project documents」区——本文档不重复维护清单，只回答「我想做某事该看哪个」。与 `agent-world` 的文档分层惯例对齐。

## 怎么读这个仓库（按场景）

| 我想… | 看 |
| --- | --- |
| 知道现在做到哪、接下来做什么 | [../handoff.md](../handoff.md) ★ 交接必读 |
| 判断项目是否达到可上线 MVP / 回看上线就绪度评审与 P0 处置状态 | [评审-MVP-20260921.md](评审-MVP-20260921.md) ★（P0-1/P0-2 已修复、#14 已拍板，仅剩 P0-3 部署控制台操作待用户） |
| 回看已完成待办明细 / 旧变更流水 / 历史 Git 同步态（handoff 归档，只读） | [handoff-archive-2026-09-20.md](handoff-archive-2026-09-20.md)（item30–36：OAuth 端到端/授权闸/Gitee OAuth/部署加固/形态 C/Actions）、[handoff-archive-2026-09-19.md](handoff-archive-2026-09-19.md)（item28/29 账号主脊 + 登录认领/认证清理）、[handoff-archive-2026-09-18.md](handoff-archive-2026-09-18.md)（item 1–27） |
| 接 GitHub / Gitee 登录 / 本人认领 / 会话与认领规则，或清理过期会话、闲置账号 | [API.md](API.md) §1.2（/auth/*、/auth/providers、claim 端点与错误码）+ Gitee 协议差异见 [design-gitee-oauth-20260919.md](design-gitee-oauth-20260919.md) + handoff item28/item29/item33；CLI `jobagent auth cleanup` 见 [../AGENTS.md](../AGENTS.md) 常用命令 |
| 登录后回到原页面（return_to 深链）/ 未登录为何看到登录墙、哪些内容要登录（授权分级闸、证据外链/面试题/面试包 401） | [design-auth-gating-20260919.md](design-auth-gating-20260919.md) ★ + [API.md](API.md) §1.2 可见性矩阵（handoff item31/32） |
| 理解产品初衷、要解决的根本问题 | [产品构想-以GitHub为桥梁的招聘系统.md](产品构想-以GitHub为桥梁的招聘系统.md) |
| 看产品范围、功能 F1–F9、画像契约、指标与风险 | [PRD.md](PRD.md) ★ |
| 回看"为什么从分析 GitHub 切入、MVP 如何收敛"的讨论过程 | [讨论记录-01-切入口与MVP收敛-20260910.md](讨论记录-01-切入口与MVP收敛-20260910.md) |
| 了解投递功能方向、Jobright 竞品深度分析、四种技术路径对比 | [讨论记录-02-投递功能与竞品分析-20260911.md](讨论记录-02-投递功能与竞品分析-20260911.md) |
| 看技术栈选型、运行架构、目录规划、M1 排期与 Spike | [技术选型-MVP-20260910.md](技术选型-MVP-20260910.md) |
| 一页看懂当前技术栈分层（客户端/服务/内核/采集/持久化五层 + 各包职责 + 数据流） | [技术栈总览-分层架构-20260916.md](技术栈总览-分层架构-20260916.md) |
| 逐条看待拍板事项与建议组合 | [待拍板决策清单-20260910.md](待拍板决策清单-20260910.md)（#1–#8 已拍板，#9–#13 延后，#14 2026-09-21 已拍板） |
| 看哪些事被刻意缓做、什么条件下重启 | [deferred-items.md](deferred-items.md) |
| 接手写代码 / 了解工程硬约束 | [../AGENTS.md](../AGENTS.md) + [../CONTRIBUTING.md](../CONTRIBUTING.md) |
| 新增 / 修改数据库结构 | [../MIGRATION_CONVENTION.md](../MIGRATION_CONVENTION.md) |
| 写提交信息 / 走分支与 PR 流程 | [../git-commit-message.md](../git-commit-message.md) + [../PULL_REQUEST_WORKFLOW.md](../PULL_REQUEST_WORKFLOW.md) |
| 处理 CI 密钥扫描（gitleaks）误报 / 增删 allowlist | [../AGENTS.md](../AGENTS.md)（工程化门禁）+ [../.gitleaks.toml](../.gitleaks.toml) |
| 部署 / 上线（形态 A/B 反代、生产 env、自动迁移、jobs/demo/auth 定时任务、上线 smoke） | [deployment-runbook-20260920.md](deployment-runbook-20260920.md) ★（形态 C 与 demo 配额已拍板，生产反代拓扑待 staging 实测） |
| 真正动手上线形态 C（照勾的分阶段操作序列：Supabase→密钥→OAuth→Vercel→DNS→Actions→预热→落地页→smoke） | [部署执行单-形态C-20260921.md](部署执行单-形态C-20260921.md) ★（配 `tools/gen-deploy-secrets.sh`、`tools/smoke-deploy.sh`；控制台步骤只能本人操作） |
| 看 AI 求职赛道的竞品认知、机会与跟进清单 | [市场调研-AI求职赛道-20260910.md](市场调研-AI求职赛道-20260910.md) |
| 看中国招聘市场企业端/求职者端双方痛点与共同根源（量化证据 + 对产品启示） | [市场调研-招聘市场痛点-20260916.md](市场调研-招聘市场痛点-20260916.md) |
| 看痛点对应解决方案、已覆盖/需新增对位与实施批次（批1 产品化 + 批2 新接口已落地见 handoff item21；批3 待外部条件） | [设计-痛点解决方案-20260916.md](设计-痛点解决方案-20260916.md) |
| 用招聘方核验视图 / 企业人才库 / 投递追踪 / 面试准备包（`?view=recruiter`、`/[locale]/recruit`、`interview-kit.md`、`/candidates` 与 `/applications` 端点） | [API.md](API.md) §3.5/§3.6 + [../handoff.md](../handoff.md) item21 |
| 写用户可见文案 / 加双语 / 处理语言与分享链接（含扩展面板、MV3 _locales） | [design-i18n-20260910.md](design-i18n-20260910.md) ★ |
| 定颜色、间距、圆角、字号 / 改主题（共享 token 包、Shadow DOM 接入） | [design-tokens-20260910.md](design-tokens-20260910.md) ★ |
| 让存储层同时支持 SQLite 与 Postgres / 新增数据库方言 | [design-storage-dual-dialect-20260911.md](design-storage-dual-dialect-20260911.md) ★ |
| 看 P2 职位聚合的数据源结论、最小链路设计与推荐组合 | [设计-职位聚合-Spike-20260913.md](设计-职位聚合-Spike-20260913.md) ★ |
| 写 P2 岗位采集管道代码（job_postings 建表 / 各源适配器 / 调度去重 / 分期） | [design-job-ingestion-20260913.md](design-job-ingestion-20260913.md) ★ |
| Gitee 证据源已落地（v5 REST 采集 / AnalyzerInput 映射 / PII 清洗 / CLI--platform + API/Worker/报告页/扩展在线选源） | [design-gitee-source-20260914.md](design-gitee-source-20260914.md) ★ |
| 行为多样性信号 / 双源 events 聚合（BehaviorEventSummary、narrow_activity_scope 弱信号、规则版本 0.2、缺失降级） | [design-behavior-diversity-20260915.md](design-behavior-diversity-20260915.md) ★ |
| 改技能标签提取（技术词典 / topics·commit·PR 多信号 / 词边界防误匹配 / 深度与置信度） | [design-skill-extraction-20260915.md](design-skill-extraction-20260915.md) ★ |
| 融合 GitHub+Gitee 双源（共享 commit oid 识别镜像去重 / fuseInputs 纯函数 / CLI `--platform all` / 在线 `platform=all` 作业与报告页第三平台入口见 §8） | [design-cross-source-fusion-20260915.md](design-cross-source-fusion-20260915.md) ★ |
| 免注册"试用演示"进入真实产品（已落地：三态身份 / 会话+IP+Worker 三道配额闸 / 预置示例 / 006–008 迁移 / API·report·extension·CLI；上线外部项见 handoff item17） | [design-demo-mode-20260915.md](design-demo-mode-20260915.md) ★ |
| 针对岗位生成定制简历（已落地 P-R1/P-R2 + P-R3 可闭环子项：resume-core 纯函数 + polish 安全层、CLI build/batch、POST /resumes/build、报告页 ResumeBuilder、扩展深链、本地补填 canonical 统一与跨端自动同步 §5.4.1；真实 LLM/服务端持久化/PDF/版本管理仍待拍板，见 handoff item18/19/24） | [design-targeted-resume-20260915.md](design-targeted-resume-20260915.md) ★ |
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
