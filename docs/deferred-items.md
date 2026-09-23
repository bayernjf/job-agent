# 缓做 / 低优事项登记表

> **单一事实源：挂起事项**。所有"讨论过、决策缓做/低优"的事项统一在此登记，每条必填**触发条件**。与 `agent-world` 的 deferred-items 惯例对齐。
> [../handoff.md](../handoff.md) 管"正在做"（活跃待办），本表管"挂着没做"。详细论证在各设计/决策文档，本表只做索引与触发条件，不重复论证。
> 创建：2026-09-10

## 使用规则

- **新增**：任何缓做/低优决策都必须在此登记一行，触发条件必填——没有明确触发条件的事项不该被缓做，应该要么做要么明确砍掉。
- **重启**：触发条件满足时，把事项移入 handoff.md 待办，本表该行标注「已重启 YYYY-MM-DD」并保留（历史可查）。
- **砍掉**：确认永不做的事项标注「已砍掉」+ 一句理由，不删行。
- 表内按"线"分组、按逻辑顺序排列，不代表优先级；重启时的优先级在移入 handoff 时再排。

## 登记表

### 产品与商业化线

| 事项 | 缓做/低优原因 | 触发条件 | 决策详情 |
| --- | --- | --- | --- |
| #9 商业模式与收费节奏（B 端 SaaS / C 端增值谁先、如何定价） | MVP 先验证分析内核的可分性与可信度；没有真实成本与转化数据前定价是拍脑袋 | 进入 P2 商业化前，且成本计量回采拿到真实成本数据 | [待拍板决策清单 #9](待拍板决策清单-20260910.md)、[产品构想](产品构想-以GitHub为桥梁的招聘系统.md) |
| #10 岗位画像与匹配引擎（匹配维度、可解释性） | 匹配是双边能力，依赖"可信画像供给 + 岗位数据"两侧就位；MVP 先做单边可信画像 | ✅ 触发条件 2026-09-13 已满足（画像 M1 就位、岗位 P2-A/B 就位，基础 matchJobs 已随 P2-D 落地）；剩余"可解释匹配理由 / 前端接线"待拍板重启（见 handoff item 12 第一/二档） | [待拍板决策清单 #10](待拍板决策清单-20260910.md)（匹配理由必须可回溯到证据） |
| #13 非技术岗多元证据源（作品集 / 案例 / 证书）接入 | `EvidenceItem` 已做成证据源无关结构；先在信号最密的技术岗（GitHub）上验证内核 | 技术岗路径跑通、需要向非技术岗扩展时 | [待拍板决策清单 #13](待拍板决策清单-20260910.md)、[PRD 第 8 章](PRD.md) |
| B/C 完整后台（招聘方工作台 / 应聘者面板） | 先用落地页轻量入口验证需求，过早建双边后台会摊薄资源、拖慢验证 | 20–50 账号去风险实验通过、进入 P2 系统层 | [PRD 阶段规划](PRD.md)、[讨论记录 01](讨论记录-01-切入口与MVP收敛-20260910.md) |
| 竞品季度监控（AI 求职赛道：B2B 进展、是否把数据源扩到行为证据） | 自身聚焦信任验证层，不做逐功能对标；但需警惕头部玩家把数据源从自述简历扩到 GitHub 等行为证据而正面竞争 | 每季度一次，或某竞品上线"行为证据/GitHub 分析"类能力时立即评估 | [市场调研-AI求职赛道 第6章](市场调研-AI求职赛道-20260910.md) |
| 简历服务端持久化与版本管理（§10 #1 已决策不持久化） | 按需生成、隐私最小化，简历不入库；没有存档就没有版本可言 | 出现明确的"历史简历存档 / 多版本对比 / 跨设备取回"需求，且账号体系（见工程线）就位时 | [design-targeted-resume §10](design-targeted-resume-20260915.md) |
| 服务端出 PDF（puppeteer / headless 渲染） | §10 #3 已决策用浏览器打印 CSS（`@media print`），服务端渲染镜像体积大、维护重 | 出现明确的"无浏览器环境 / 服务端批量出 PDF / 邮件附带 PDF"需求时 | [design-targeted-resume §10](design-targeted-resume-20260915.md) |
| ✅ **已落地 2026-09-17（见 handoff item24）** 本地档案跨端自动同步（扩展 ATS ↔ 报告页简历） | ~~扩展 content script 在第三方 ATS 域、报告页在产品域，且服务端不持久化，物理上无法共享 localStorage~~ 已通过扩展 `chrome.storage` + `externally_connectable` 通道打通：固定扩展 ID（manifest `key` 派生 `dgbnkdljapgglpdcmncbleioocbjfmmc`）+ background 消息处理，两端经 chrome.storage.local（跨域权威）自动合并（`mergeLocalProfile` 新值优先、本域 localStorage 降级）；schema 统一先于 item19 ①（2026-09-16）落地 | ~~账号体系落地，或扩展通道~~ **已落地 2026-09-17**；剩余联调依赖报告页与扩展 ID/白名单匹配，见 apps/extension/INSTALL.md | [design-targeted-resume §5.4.1](design-targeted-resume-20260915.md) |

### 证据源与分析深度线

| 事项 | 缓做/低优原因 | 触发条件 | 决策详情 |
| --- | --- | --- | --- |
| #11 L2 clone 静态分析 + 隔离沙箱 | MVP 只做 L0 元数据 + L1 行为时序、**不 clone**，以规避供应链安全面与资源成本；L2 需隔离沙箱 | 进入 P3 前，且 L0/L1 信号被证明不足以支撑目标结论 | [待拍板决策清单 #11](待拍板决策清单-20260910.md)、[技术选型](技术选型-MVP-20260910.md) |
| L3 / L4 更深分析（代码语义、长期演进等） | 依赖 L2 的代码获取与沙箱先成立，逐级递进 | L2 落地并验证成立后 | [PRD 分析分层 L0–L4](PRD.md) |
| ✅ **G-A + G-B 已落地 2026-09-14（CLI 闭环 + 在线分析链路选源，见 handoff item 14）** #12 Gitee / 多证据源接入：新增 `packages/gitee-source`（v5 REST-only）+ shared/analyzer 多平台参数化 + CLI `--platform github|gitee` + API/Worker/报告页/扩展全链路在线选源 | 契约层已预留 `EvidenceSource` 抽象；G-A CLI 闭环 + G-B 在线链路（API platform 枚举、Worker 多源路由、报告页/扩展平台切换 UI）均已落地。**events/public 行为流补充已于 2026-09-15 落地（方案 A：只动 gitee-source，单次取最近 20 条补近期 PushEvent 提交与最近活跃，见设计 §4.11）**；**跨源镜像去重内核 + CLI 最小双源融合已于 2026-09-15 落地**（共享 commit oid 识别镜像、`fuseInputs` 纯函数、CLI `analyze --platform all`，见 [design-cross-source-fusion-20260915](design-cross-source-fusion-20260915.md)）；**在线多源融合画像（`platform=all`）已于 2026-09-16 落地**（API/Worker 一次作业双采 GitHub+Gitee、镜像去重、融合画像按虚拟检索键 `all` 持久化、报告页第三平台入口，零迁移/零契约改动，Gitee 404 正常降级、瞬时错误重试，见该设计 §8 与 handoff item20）。**跨源融合收尾三项已于 2026-09-17 落地（见 handoff item22）**：跨源 PR/issue 同帖去重（仅镜像配对仓内、同类型、标题规范化相同、创建时间差 ≤7 天的保守一对一去重，丢弃辅源重复帖及其证据）、融合双源徽标（报告页头部 + 人才库卡片/平台筛选，据存储行 `subject_platform=all` 识别）、扩展面板 all 第三键；**FusionReport 已随融合画像快照持久化并在报告页头部展示去重统计（2026-09-17，item23，零迁移：AbilityProfile 新增可选 `fusion` 节，单源画像缺省、旧快照仍可解析）**。**all 融合作业配额权重已于 2026-09-18 拍板落地**（一次扣 `DEMO_FUSION_QUOTA_COST` 默认 2、单源扣 1、剩余不足整单拒绝不部分扣，见 [design-demo-mode §3.1/§16-#6](design-demo-mode-20260915.md)）；**跨源同帖去重 7 天窗同日拍板锁定**（`CROSS_SOURCE_THREAD_WINDOW_MS = 7 天`、判据 `<=`，边界测试钉成契约，见 [design-cross-source-fusion §8.7](design-cross-source-fusion-20260915.md)）。**剩余缓做**：~~Gitee OAuth 认领（已落地 2026-09-19 item33，见 [design-gitee-oauth-20260919](design-gitee-oauth-20260919.md)）~~、认证态精确限频、L2 clone；~~行为多样性信号（动 analyzer 内核的方案 B）~~ **方案 B 已于 2026-09-15 落地**（双源聚合 `BehaviorEventSummary` + 保守弱信号 `narrow_activity_scope` + 规则版本 0.1→0.2，见 [design-behavior-diversity-20260915](design-behavior-diversity-20260915.md)），真实 26 账号双源回归已闭环：2026-09-17 首跑（GitHub 26/26 narrow 零误伤；Gitee 匿名 7 成功、8 账号撞小时限频），**2026-09-18 带 `GITEE_TOKEN` 补跑完成**——Gitee 9 成功（全 insufficient_data 0.35、narrow 零触发）/ 17 全为 404 账号不存在 / 0 账号级 403，澄清上次 8 个 403 中 leerob/wycats 实存、其余 6 个本就 404；规则 0.3 同日双源复核零误伤（见 handoff item26） | 在线多源融合已落地（2026-09-16，见 handoff item20），融合收尾三项（同帖去重/双源徽标/扩展 all 入口）已落地（2026-09-17，item22），FusionReport 持久化与报告页去重统计已落地（2026-09-17，item23）；~~all 配额权重：已落地 2026-09-18（默认扣 2、env 可配、整单拒绝）；同帖去重 7 天窗同日锁定~~；Gitee OAuth/认证限频重启条件＝生产需要本人认领或撞到认证限频；行为多样性方案 B 已落地（2026-09-15），其真实 26 账号双源回归已闭环（2026-09-17 首跑 + 2026-09-18 带 token 补跑，见 handoff item26）——GitHub 全量零误伤、Gitee 9 个存在账号零误伤（17 个为 Gitee 不存在的 404）；另观察到 `events/public` 端点即使带 token 仍可能 403（已由 `missing:'events'` 降级覆盖，不阻塞出画像） | [实现设计 design-gitee-source-20260914](design-gitee-source-20260914.md)、[Gitee Spike](design-gitee-source-spike-20260914.md)、[待拍板决策清单 #12/#4](待拍板决策清单-20260910.md) |

### 平台与工程线

| 事项 | 缓做/低优原因 | 触发条件 | 决策详情 |
| --- | --- | --- | --- |
| Redis / 消息队列 | MVP 用单进程 Worker 轮询 `analysis_jobs` 即可，引入中间件徒增运维面 | 单进程轮询的吞吐/延迟成为瓶颈，或需要多 Worker 并发消费 | [技术选型](技术选型-MVP-20260910.md)、[../AGENTS.md](../AGENTS.md) |
| LLM 层启用（`packages/llm`） | 规则内核先做到可复现、可解释、带版本；分析内核的 LLM 输出不稳定，必须经结构化校验，过早接入会污染可复现性。**注：简历 B 档受约束润色已于 2026-09-16 落地（OpenAI 兼容 client + 数字防臆造安全层，默认关闭，见 design-targeted-resume §7/§10），不在本缓做范围** | 分析内核侧：规则内核在标注集上稳定后，确需自然语言摘要 / 面试题润色时；简历侧：用户自配 `LLM_*` env 即启用，无需重启本项 | [技术选型](技术选型-MVP-20260910.md)、[design-targeted-resume §7](design-targeted-resume-20260915.md)、[../AGENTS.md](../AGENTS.md) |
| ✅ **GitHub 登录 + 本人认领已落地（item28 后端 2026-09-18 / item29 前端 + 清理 2026-09-19）** 账号体系 / 本人认领头表（accounts、claim、OAuth） | ~~M1 先做"用户名 → 画像"匿名分析 + waitlist；账号与认领形态取决于决策 #1/#6~~ 决策 #1-A/#6-A 已拍板并落地：GitHub OAuth 登录 + accounts/auth_sessions（迁移 010/011）+ 服务端会话 + 本人 claim（后端 5 端点）、报告页全局登录入口/登录态/退出/认领 CTA、CLI `auth cleanup` 本体 | **剩余缓做**：~~Gitee 平台 OAuth 登录（已落地 2026-09-19 item33：`GiteeAuthProvider` + `/auth/gitee/login`·`/callback` + `GET /auth/providers` + 报告页 Gitee 登录入口，`platform` 字段本就预留 `gitee`，见 [design-gitee-oauth-20260919](design-gitee-oauth-20260919.md)；真实 OAuth App 凭证/回调域名仍随部署）~~；Gitee 认证态精确限频的重启条件＝撞到认证限频 | [待拍板决策清单 #1/#6](待拍板决策清单-20260910.md)、[API.md §1.2](API.md)、handoff item28/item29 |
| ✅ **授权分级闸已落地 2026-09-19（见 handoff item32、[design-auth-gating](design-auth-gating-20260919.md)）** ~~未登录/非本人浏览他人画像时折叠哪些重模块（完整证据/面试题/联系方式等）~~ | ~~item28/29 只做登录+认领、刻意不改公开画像只读可见性；折叠范围是产品决策、需先拍板，先做会误伤分享传播~~ 已落地报告页两档模型：未登录（anonymous/demo）看公开门面，登录 user 解锁招聘方三视图原始证据外链、面试题、面试准备包（`interview-kit.md` 端点未登录 401），面试题未登录折叠为题数+登录墙；结论/技能/匹配/简历/投递与匹配理由证据仍公开 | ~~真实 OAuth 联调通过、准备上线/公开分享前且折叠范围拍板~~ **已落地 2026-09-19**；剩余仅 JSON API 字段级裁剪（见下一行，触发条件＝公开分享后 API 被抓取/搬运滥用） | [API.md §1.2](API.md)、[design-auth-gating-20260919](design-auth-gating-20260919.md) |
| ✅ **OAuth `return_to` 深链回跳已落地 2026-09-19（见 handoff item31、[design-auth-gating](design-auth-gating-20260919.md)）** | ~~后端固定回 `AUTH_AFTER_LOGIN_URL` 默认 `/`；逐请求回跳需同源 allow-list 防开放重定向，当时无深链回跳需求~~ 已落地：纯函数 `sanitizeReturnTo` 同源相对路径白名单（单 `/` 开头、拦协议相对 `//`/`/\`、绝对 URL/scheme、控制字符、超长 2048、回 `/auth/`），经短期 HttpOnly Cookie `jobagent_oauth_return` 流转、不进 GitHub state/不落日志、回调二次校验用完即删，非法回退 `AUTH_AFTER_LOGIN_URL`；报告页登录墙与 AccountMenu 均带当前页深链 | ~~出现「从外部分享/报告深链触发登录、登录后要回原页面」的明确需求~~ **已落地 2026-09-19**（账号收尾两刀之一） | [API.md §1.2](API.md)、[design-auth-gating-20260919](design-auth-gating-20260919.md) |
| JSON API 字段级授权裁剪（未登录调用 `/profiles/:id` 时连面试题文本等也裁掉） | 报告页人机界面已墙、`exportable` 投影本就无证据 URL/面试题，扩展一键填充依赖其公开；当前未登录 API 面基本拿不到证据 URL，过早裁剪会破坏扩展与分享链路 | 对外公开分享后出现 API 被批量抓取/搬运画像内容的滥用，或招聘方滥用投诉时 | [API.md §1.2](API.md)、[design-auth-gating-20260919](design-auth-gating-20260919.md) |
| 认证数据清理的生产 cron 调度（过期/已撤销 auth_sessions、未认领闲置 accounts） | CLI 可执行本体 `jobagent auth cleanup` 已落地（item29，默认会话保留 24h、未认领账号 30d）；形态 C 已拍板由 Vercel Cron 每日调 `/api/internal/cron/cleanup?task=all` 承载（demo + auth 同端点，代码已就绪），无需常驻环境 | **形态 C 部署阶段 E**：在 Vercel 项目配置每日 cron 与 `CRON_SECRET`（见 [部署执行单](../部署执行单-形态C-20260921.md) E 阶段、Runbook 定时任务映射）；自托管形态则挂系统 cron 跑 `jobagent auth cleanup` | [../AGENTS.md](../AGENTS.md)、handoff item29/item35 |
| ✅ **已重启 2026-09-11（W3-6 进行中，见 handoff）** Postgres 方言适配（`packages/storage` 双轨），设计见 [design-storage-dual-dialect](design-storage-dual-dialect-20260911.md) | MVP 持久化层已用 SQLite 跑通迁移/仓储机制（本地/实验合法场景）；在线服务主轨是 Postgres，需补 pg 方言 schema/client、`COMMENT ON` 迁移与 CI service | ~~W3 服务化前~~ **已触发重启**；CI Postgres service 已于 2026-09-18 落地（`postgres:16-alpine` service + job 级 `DATABASE_TEST_URL`，`postgres-behavior` 7 用例在 CI 真实 PG 实跑）；JSONB/TIMESTAMPTZ、SKIP LOCKED 仍缓做（见设计文档 §9） | [技术选型 6.5](技术选型-MVP-20260910.md)、[../MIGRATION_CONVENTION.md](../MIGRATION_CONVENTION.md) |
| 生产报告页域名与扩展 `externally_connectable` 白名单 | 跨端自动同步（本表「本地档案跨端自动同步（扩展 ATS ↔ 报告页简历）」行已落地）后，扩展 manifest 的 `externally_connectable` 仍只有本地地址 + 生产占位 `https://job-agent.bayjf.com`；**部署形态已拍板为 C（Vercel 单项目同域，建议域 `app.job-agent.bayjf.com`）**，但真实域名要等 DNS 落地才能定，提前改等于猜 | **形态 C 部署阶段 F（域名/DNS 落地）时触发**：用 `EXTENSION_API_BASE=https://<真实域>/api EXTENSION_SITE_ORIGIN=https://<真实域> pnpm --filter @jobagent/extension release` 重打 CWS zip（release 脚本 2026-09-23 已落地，自动剥离 localhost、改写占位域）；首次对外分发扩展前必须完成 | [design-targeted-resume §5.4.1](design-targeted-resume-20260915.md)、[apps/extension/INSTALL.md](../apps/extension/INSTALL.md)、[store-assets README](../apps/extension/store-assets/README.md) |
| CWS 截图用生产 API 构建重截（去掉 localhost placeholder、更新英文 claim） | item40 的 5 张 1280×800 截图截于 2026-09-21：截图 02 仍是 item41 英文化之前的中文 claim，且高级字段面板含 localhost API 占位；重截需要真实运行的生产 API（by-subject/presets/match 端点）与重新生成的英文 claim 画像 | **形态 C 生产 API 上线后、CWS 提交前**：用 release 构建 + 生产 API 重跑 `apps/extension/store-assets/capture.mjs`（步骤见 store-assets README，pre-submit checklist 第 3/8 条） | [store-assets README](../apps/extension/store-assets/README.md)、handoff item40/item48 |
| gitleaks 自定义 allowlist 的规模化 | 目前仅一条 allowlist（扩展 manifest `key` 的公钥结构），单文件手写足够；引 baseline/外部配置管理会增加漏报面 | 出现第二条以上需要宽松放行的规则，或 allowlist 需要按目录/团队拆分时 | [../.gitleaks.toml](../.gitleaks.toml)、[../AGENTS.md](../AGENTS.md) |

### 界面与国际化线

| 事项 | 缓做/低优原因 | 触发条件 | 决策详情 |
| --- | --- | --- | --- |
| 引入 i18n 框架（i18next / Paraglide 等） | 自研 `t()` + JSON 字典已覆盖 P0 需求，引框架会新增依赖与配置面（AGENTS：未经明确需求不引入新框架） | 需要复数/性别/复杂日期形态，或字典规模使手工维护明显吃力（如 >200 key），或要上第三语言 | [design-i18n](design-i18n-20260910.md)、[../AGENTS.md](../AGENTS.md) |
| 第三语言与机翻 / 翻译协作管线 | 决策 #4 只要求海内外同步（中英），第三语言无需求信号 | 出现非中英市场的真实需求信号（用户来源分布或付费意向显著） | [design-i18n](design-i18n-20260910.md)、[待拍板决策清单 #4](待拍板决策清单-20260910.md) |
| 落地页 `--lui-*` 纳入共享 token 体系 | 落地页是独立仓库、自有变量体系，由负责人自行推进；本仓内 report 与 extension 已共享 `packages/ui-tokens`（2026-09-14，见 [design-tokens](design-tokens-20260910.md)） | 落地页需要与本仓视觉统一（品牌一致性成为硬需求）时 | [design-tokens](design-tokens-20260910.md) |
| i18n 运行时抽共享包（`packages/i18n`） | 目前仅 report 与 extension 两个前端、字典各自演化，各持一份无 DOM 依赖的小运行时成本最低 | 出现第三个前端，或两端都需要复数/性别/复杂日期等复杂规则时 | [design-i18n §8.1](design-i18n-20260910.md) |
| Stylelint / 自动化 token 与文案检查 | MVP 用单测 + 只读脚本即可守住"禁 hex""禁硬编码文案"，引 lint 增加工具链 | 硬编码 hex 或文案靠人工 review 漏过两次，或组件数量增长使人工 review 不可靠 | [design-tokens](design-tokens-20260910.md)、[design-i18n](design-i18n-20260910.md) |
| ✅ **已落地 2026-09-22（方向 A：模板直接英文化，见 handoff item41，commit `3ddd18c`）** ~~采集层证据 `claim` 模板双语化（`github-source`/`gitee-source` 的 `evidence.ts` 原为写死中文，如「仓库 owner/name（语言）：N star / M fork，最近推送 …」）~~ | claim 是采集期写入证据快照的文本、不属于前端 `t()`；2026-09-22 因 CWS 提交在即、英文截图露出中文行，按最小方向 A 处理：两源 5 类模板（账号/仓库/提交/PR/Issue）统一改英文，claim 仅展示不被解析、零 schema/内核改动；确定性夹具同步改英文。**若未来需要按 locale 分别渲染中英文 claim（方向 B 加 `claimEn` 字段 / 方向 C claim 结构化），作为新事项重新登记**，旧画像快照中的历史 claim 文本不回改 | ~~英文报告/扩展面向真实英文用户公开发布前，或商店审核/用户明确反馈英文界面夹中文证据描述时~~ **已触发并落地（CWS 上架准备，2026-09-22）** | [../AGENTS.md](../AGENTS.md)（i18n 规范）、handoff item40/item41 |

### 合规线

| 事项 | 缓做/低优原因 | 触发条件 | 决策详情 |
| --- | --- | --- | --- |
| ✅ **已拍板并移出缓做 2026-09-21** #14 数据留存周期、分享链接撤销/过期、删除权策略 | 产品侧姿态已定：长期留存+应求删除、链接不自动过期+应求撤销，通道为报告页异议 mailto；法务最终意见仍为外部项 | 已触发（2026-09-21 拍板） | [待拍板决策清单 #14 记录](待拍板决策清单-20260910.md)（GDPR / 个人信息保护法以法规原文与法务为准） |

## 已重启 / 已砍掉

（暂无——首建时全部挂起）
