# Handoff 历史归档（2026-10-31c，同日第三次轮转）

> 归档惯例（对齐 agent-world，2026-09-18 起执行）：主文件只保留「项目当前状态 + 活跃任务 + 最近 5 条变更 + 文档索引」；编号待办标 ✅ 后，详细过程整块滚入本类文档，主文件只留**一行结论 + commit hash**。归档文件冻结只读、不再追加。
> 本归档对应：活跃待办台账瘦身轮转——item1–148 的**一行结论台账**（明细早已分别归档于 2026-09-18 ~ 2026-10-12 各历史档 §1，见主文件「已完成」指针行）从主文件整块迁入本文件，原文逐字、编号不改、零删除；**item149–166（2026-10-11 → 10-24 最新批次）与活跃项保留在主文件**。

## §1 已完成待办一行结论台账（item1–148，从主文件整块迁入，内容未改）

1. ✅ **M1·W1 持久化层 + 首个迁移**（2026-09-11）
2. ✅ **M1·W2 github-source + analyzer-core + cli**（2026-09-11）
3. ✅ **#8 去风险 S1/S2 spike**（2026-09-11）
4. ✅ **修复 spike 暴露 3 个 bug + 回归**（`0ceed62`，2026-09-11）
5. ✅ **#8 重新批量验证 + 真实性三轮双向校准**（26 账号：22 正 0 误报 + 4 负 0 漏报，2026-09-11~12，`a4f07d2`/`72490de`/`7fd6ca2`）
6. ✅ **M1·W3 服务化**（W3-1~W3-6，四表+仓储+worker+api+双方言，2026-09-11，`5a8407c`…`5cc700a`）
7. ✅ **M1·W4 报告与分享**（W4-1~W4-6，Astro 7 SSR + i18n + token + 只读分享 + 落地页接线，2026-09-11）
8. ✅ **端到端联调**（api+worker+report 三服务主链路，2026-09-11）
9. ✅ **P1·Chrome 扩展一键填充**（第 1–3 步 + Lever 零改动跑通 + Workday 受限登记；summary→自定义问题映射；i18n+设计 token，2026-09-11~14，`d350e43`/`47eece9`/`9b31fd0`/`e22d080`/`5bc411a`/`3286ca7`/`efe61e6`）——剩余外部项（真实用户装扩展试用、分发策略 CRX 先行已采纳、Workday 直渲染租户端到端）见「已知限制」
10. ✅ **P2·职位聚合**（JobPosting 契约 + Spike + 采集管道 + 五源入库 2044/1588 + matchJobs 匹配 + 四 API 端点 + 出站代理，2026-09-13，`c0e6a4b`/`da13802`/`ff070dc`/`d2cb688`）
11. ✅ **工程化补全 10 项**（Playwright E2E/Docker/真实 PG/pre-commit 卡死修复/画像缓存/CLI 导出/API 文档/waitlist CLI/i18n 测试，2026-09-12，`693e3e8`）
12. ✅ **P2 之后功能闭环路线**（第一档画像↔岗位匹配端到端接线 PR #23；第二档 #10 可解释性 + 扩展匹配 UI + 分档统一 + Gitee G-A/B；第三档继续缓做，2026-09-14，`620f79d`）
13. ✅ **工程化补全·组合一**（Dockerfile 漏 COPY 修复 + CI 补 E2E/Docker smoke + 推荐岗位 E2E + API 文档，PR #24；Docker arm64 运行时实跑 + PG 并发首迁移修复 `4c4ebe7`，2026-09-14~16）
14. ✅ **#12 Gitee 第二证据源**（G-A CLI 闭环 + G-B 在线选源 + events 方案 A + 行为多样性方案 B 规则 0.1→0.2，2026-09-14~15）
15. ✅ **B-4 技能标签精确提取**（技术词典 + 多信号 + 词边界，`262d198`，2026-09-15）
16. ✅ **B-5 跨源镜像去重 + 最小双源融合**（`fuseInputs` 纯函数 + CLI `--platform all`，`cfffd53`/`098d4b6`/`618aa59`，2026-09-15）
17. ✅ **演示模式 Demo Mode**（三态身份 + 三道配额闸 + 迁移 006–008 + 九步落地，2026-09-15，`7ac700b`…`2e01eec`）——剩余外部项（配额数值/TTL、部署形态、生产 cleanup cron、真人试用）见「已知限制」
18. ✅ **岗位定向简历生成**（P-R1 规则版 + P-R2 在线消费 + P-R3 可闭环子项含 OpenAI 兼容 LLM 润色默认关闭；§10 五项已决策，2026-09-15~16）——真实 LLM 需自配 `LLM_*`、服务端 PDF/版本管理缓做
19. ✅ **简历后续两项**（报告页 AI 润色开关 + 本地档案 canonical 统一，2026-09-16，`c944872`/`f1dd8c0`/`1e4f20b`/`13039a0`/`cd429b3`）
20. ✅ **在线多源融合画像 platform=all**（Worker/API/报告首页接线 + 缓存平台隔离 + UI bug 修复，2026-09-16）
21. ✅ **招聘痛点解决方案·批次 1+2**（核验视图/面试准备包/人才检索/筛选工作台/投递追踪，9 提交顶部 `304e7fb`，2026-09-16）
22. ✅ **跨源融合收尾三项**（PR/issue 同帖去重 + 扩展 all 第三键 + 双源徽标，PR #54，2026-09-17，`fcfa330`/`5362a9f`/`39f944c`）
23. ✅ **FusionReport 持久化 + 报告页去重统计**（PR #54，2026-09-17，`d991347`…`6743a4e`）
24. ✅ **本地档案跨端自动同步**（chrome.storage + externally_connectable，PR #55，2026-09-17，`715f34d`/`e7f9c2c`/`51ebc64`）——生产域名未定，externally_connectable 白名单含占位
25. ✅ **self_pr_ratio 判定强化 + 规则 0.2→0.3**（PR #55，2026-09-17，`db676cd`/`39cf3c5`）
26. ✅ **规则 0.3 真实双源回归复核**（GitHub 26/26 + Gitee 9 成功零误伤，holilayet 回归 mixed，2026-09-18）
27. ✅ **换 Windows 设备全量复核 + all 融合作业 demo 配额权重扣 2 + 跨源同帖去重 7 天窗锁定**（2026-09-18，`CROSS_SOURCE_THREAD_WINDOW_MS` 导出锁定、`DEMO_FUSION_QUOTA_COST` 可配）
28. ✅ **本人授权主脊：GitHub OAuth 登录 + accounts/auth_sessions + 本人认领（决策 #1-A/#6-A）**（2026-09-18，6 提交 `0c578f0` shared → `9f64e5e` db → `ec23cb6` storage → `8c089fc` api → `e3a93dc` docs(api) → `9d9c51e` docs(handoff)；明细归档 [handoff-archive-2026-09-19](docs/handoff-archive-2026-09-19.md) §1）
29. ✅ **账号主脊前端接线 + 认证数据运维清理（报告页 AccountMenu/ClaimProfile + CLI `auth cleanup`）**（2026-09-19，4 提交 `b30b494` db → `33a072d` cli → `87a80c2` report → `aae32ef` docs(handoff)；明细归档 [handoff-archive-2026-09-19](docs/handoff-archive-2026-09-19.md) §2）
30. ✅ **真实 GitHub OAuth 登录本地端到端打通（出站代理 + 跨端口 cookie 两处根因修复，真实浏览器验证登录/退出/认领落库）**（2026-09-19，3 提交 `60ad930` api → `9cb7ac9` report → `c7b3ecb` docs(handoff)；明细归档 [handoff-archive-2026-09-20](docs/handoff-archive-2026-09-20.md) §1）
31. ✅ **OAuth 登录后 `return_to` 深链回跳（`sanitizeReturnTo` 白名单防开放重定向）**（2026-09-19，`b8f3881` api + `d8504bd` docs(auth)；明细归档 09-20 §2，设计 [design-auth-gating-20260919](docs/design-auth-gating-20260919.md)）
32. ✅ **报告页授权分级闸（未登录看公开门面，登录 user 解锁证据外链/面试题/面试包，interview-kit 未登录 401）**（2026-09-19，`39e083a` report；明细归档 09-20 §3，设计 [design-auth-gating-20260919](docs/design-auth-gating-20260919.md)；JSON API 字段级裁剪缓做见 deferred）
33. ✅ **Gitee 平台 OAuth 登录与本人画像认领（对称 GitHub 主脊的第二个 AuthProvider，零迁移）**（2026-09-19，3 提交 `7f2d525` api → `53f177c` report → `fbcf720` docs(auth)；明细归档 09-20 §4，设计 [design-gitee-oauth-20260919](docs/design-gitee-oauth-20260919.md)；真实 Gitee App 凭证首次冒烟为外部项）
34. ✅ **部署加固批次（GateCard Gitee 登录墙 E2E + 部署/上线 Runbook + README/docs 导航，零产品代码改动）**（2026-09-20，`90cbe35` test(report) → `c6df859` docs(deploy) Runbook → `4f31324` docs(handoff)；明细归档 09-20 §5，Runbook [deployment-runbook-20260920](docs/deployment-runbook-20260920.md)）
35. ✅ **形态 C 生产部署代码就绪：Vercel 单项目同域（报告页 `/` + Hono `/api/*`）+ Supabase Postgres + Vercel Cron 替代常驻 Worker**（2026-09-20，7 提交 `8478b8c`…`fec98b0`；明细归档 09-20 §6；**当时尚未真实部署，生产已于 2026-09-30 上线**，Supabase/Vercel Pro/生产域名/OAuth App/随机密钥等控制台待办见 Runbook §11）
36. ✅ **岗位同步 GitHub Actions workflow（每日四源/每月 HN）+ 形态 C API 文档（§5 内部 cron 端点、`/api` 前缀约定）**（2026-09-20，`9da501d` ci(deploy) → `11c6fca` docs(api)，后者为 `bab3dd8` push 前 amend；明细归档 09-20 §7；上线前需配 Actions secret `DATABASE_URL`=5432 Session pooler 串）
37. ✅ **MVP 上线评审接力（P0-1 证据落库 `df95506`、P0-2 异议 mailto `9d2c75d`、#14 合规与 demo 配额 3 次/24h 决策 `f4d12bd`/`ec68c1f`/`f20cfcc`）**（2026-09-21，结论＝纯代码侧可闭环项清空、剩 P0-3 控制台部署；明细归档 [handoff-archive-2026-10-01](docs/handoff-archive-2026-10-01.md) §1）
38. ✅ **评审非阻塞瑕疵收尾 + 形态 C 同域挂载守护（CLI `--format`、`stripApiPrefix`/`resolveBrowserApiBase`）**（2026-09-21，PR #70；明细归档 [handoff-archive-2026-10-01](docs/handoff-archive-2026-10-01.md) §1）
39. ✅ **形态 C 部署执行包（照勾执行单 + `tools/gen-deploy-secrets.sh`/`tools/smoke-deploy.sh`）**（2026-09-21，PR #70；明细归档 [handoff-archive-2026-10-01](docs/handoff-archive-2026-10-01.md) §1）
40. ✅ **Chrome Web Store 上架素材包 + 修复四个真实扩展缺陷**（2026-09-21，PR #70；明细归档 [handoff-archive-2026-10-01](docs/handoff-archive-2026-10-01.md) §1）
41. ✅ **采集层证据 claim 模板英文化**（2026-09-22，`0284e71`，PR #72；明细归档 [handoff-archive-2026-10-01](docs/handoff-archive-2026-10-01.md) §1）
42. ✅ **CI 补 actionlint job（镜像 tag 钉 1.7.12）**（2026-09-22，`0b3a9f8`，PR #72；明细归档 [handoff-archive-2026-10-01](docs/handoff-archive-2026-10-01.md) §1）
43. ✅ **Windows 跨设备 Node v24 全量回归（781 单测/52 报告 E2E/9 扩展 E2E）**（2026-09-22，`61da85b`，PR #70；明细归档 [handoff-archive-2026-10-01](docs/handoff-archive-2026-10-01.md) §1）
44. ✅ **handoff 最近变更裁剪归档**（2026-09-22，`123892e`，PR #72；明细归档 [handoff-archive-2026-10-01](docs/handoff-archive-2026-10-01.md) §1）
45. ✅ **面试计划表 Interviews（迁移 012 + 登录闸三端点 + `/recruit` island，不引入 recruiter 角色）**（2026-09-24，`ef9b017`…`c458cb6`，PR #81；明细归档 [09-24](docs/handoff-archive-2026-09-24.md) §4）
46. ✅ **扩展真机验证批次 #52–#57（background SW 代发 / by-subject 匿名加载 / 字段消歧 / Website 填充）**（2026-09-22，`3fbf8b8`/`788a026`/`efadd8b`/`d23c1ae`，PR #72；明细归档 [09-22](docs/handoff-archive-2026-09-22.md)）
47. ✅ **两端本地档案字段对齐 + PG 测试真实验证 + 文档基线 + deferred 复核**（2026-09-22，`f321b41`…`3d3c4fd`；明细归档 [09-23](docs/handoff-archive-2026-09-23.md) §1）
48. ✅ **09-22 上线就绪评审 A 组本地闭环（A1–A7）**（2026-09-22，`bca7053`…`df67bdd`；明细归档 [09-23](docs/handoff-archive-2026-09-23.md) §2）
49. ✅ **部署前测试基建加固 + 全量回归基线 #113–116**（2026-09-23；明细归档 [09-23](docs/handoff-archive-2026-09-23.md)）
50. ✅ **部署前收尾批次 T1–T8（release 打包 / CWS 素材重截 / 文档修正）**（2026-09-23，`48fa3d0`…`c63c39c`，PR #77；明细归档 [09-24](docs/handoff-archive-2026-09-24.md) §1）
51. ✅ **部署前最后一公里验证 + CWS 上架前准备（835 单测/隐私政策/smoke 7/7）**（2026-09-24，`10281c0`…`75f471b`，PR #79；明细归档 [09-24](docs/handoff-archive-2026-09-24.md) §2）
52. ✅ **交付态总览图重制 + 当前 HEAD 全量回归 + `tools/preflight.sh`**（2026-09-24，`0e75bc1`/`c350e39`/`b5b9913`，PR #81）
53. ✅ **部署前收尾·第一档纯代码加固 T1–T3（深健康检查 / demo 配额并发压测 / 隐私政策一致性守护）**（2026-09-24，PR #81）
54. ✅ **上线前门禁补缺口 T0–T3（部署冒烟 10 项 / env 四处一致性守护 / preflight `--deploy`）**（2026-09-24，`4c1143d`，PR #82；明细归档 [09-24](docs/handoff-archive-2026-09-24.md) §5）
55. ✅ **迁移 CLI 目标库与 `DB_PATH` 对齐（`resolveSqliteDbPath` + 修 `scripts/migrate-down`）**（2026-09-25，PR #83）
56. ✅ **文档链接完整性批次 + `doc-links.test.ts`（第 3 条文档守护）**（2026-09-25，`636a23a`…`eb0852b`，PR #84）
57. ✅ **文档命令可跑性审计 + `doc-commands.test.ts`（第 4 条文档守护）**（2026-09-25，`453dcfd`/`59e0971`）
58. ✅ **「未经本人授权」显著标注（合规第一刀：报告页提示条 + 候选人卡徽章）**（2026-09-25，`40ae636`，PR #87）
59. ✅ **B 端角色与组织·F10 招聘方声明 + 访问闸（#17 第一期，迁移 015）**（2026-09-30，`aaa632b`…`307fd7b`；设计 [design-recruiter-roles-20260925](docs/design-recruiter-roles-20260925.md)）
60. ✅ **C 端优先重排方案 #18 决策（T01–T22 见方案 §9）**（2026-09-25；设计 [design-c-side-first-20260925](docs/design-c-side-first-20260925.md)）
61. ✅ **批次 0 投递管道隐私落地（T01–T03b / #17-F11，迁移 013 加 `created_by_account_id`）**（2026-09-25）
62. ✅ **批次 1 起手：T04 技能目录 AI/Agent 层 + T11 简历下载丢字段**（2026-09-25，`d4930b9`…`9d13d03`）
63. ✅ **T05 topics 兜底生产者 + 规则版本 0.4**（2026-09-25）
64. ✅ **T06 PR 改动规模入证据（`mergedDiffLines`/`largestMergedPrDiff`）**（2026-09-25）
65. ✅ **T07 headline 平台化 + 双语（`composeHeadline`）**（2026-09-25，`73ea75f`…`13ba268`）
66. ✅ **T08 规则 0.4 双向零误伤回归通过**（2026-09-25）
67. ✅ **第三次 MVP 上线就绪评审**（2026-09-25；见 [docs/评审-MVP-20260925.md](docs/评审-MVP-20260925.md)）
68. ✅ **批次 6 全部落地（T24 岗位池写入 / T25 失败显式化 / T26 删除解绑 / T27 fail-open 收口 + T17 我的页 + T09 improvementSuggestions，规则 0.4→0.5）**（2026-09-25，`fc8e2e2`…`7556a30`；明细归档 [09-25](docs/handoff-archive-2026-09-25.md)）
69. ✅ **T24 落地（并入 item68）**（2026-09-25；归档 [09-25](docs/handoff-archive-2026-09-25.md) §3）
70. ✅ **T25 落地（并入 item68）**（2026-09-25；归档 §2）
71. ✅ **T26 落地（并入 item68）**（2026-09-25；归档 §4）
72. ✅ **T17 落地（并入 item68）**（2026-09-25；归档 §5）
73. ✅ **T09 落地（并入 item68）**（2026-09-25；归档 §6）
74. ✅ **T27 落地（并入 item68）**（2026-09-25；归档 §7）
75. ✅ **同日复评（评审 §9，阻断集 4→1+1，新立批次 7 T28/T29/T30）**（2026-09-25；明细归档 [handoff-archive-2026-10-01](docs/handoff-archive-2026-10-01.md) §1）
76. ✅ **T28 落地：一次分析只发布一份可分享结论（删 `updateSnapshot` 死 API）**（2026-09-25；明细归档 [handoff-archive-2026-10-01](docs/handoff-archive-2026-10-01.md) §1）
77. ✅ **T28 真进程验证 + 撞出新 P0＝T31「回访即崩」（evidence 主键冲突）**（2026-09-25；明细归档 [handoff-archive-2026-10-01](docs/handoff-archive-2026-10-01.md) §1）
78. ✅ **T31 修复：证据行按画像隔离（迁移 014，复合主键 `(profile_id, id)`）**（2026-09-26，`e6a59eb`/`b7cdb03`）
79. ✅ **T32 落地：迁移器「一个文件一条事务」**（2026-09-26）
80. ✅ **T10 落地：报告页「下一步动作」区块（规则 0.5→0.6）**（2026-09-26）
81. ✅ **CI 报告 E2E 偶发超时登记（并入 T29 完成判据）**（2026-09-26；明细归档 [10-01](docs/handoff-archive-2026-10-01.md) §1）
82. ✅ **T12 + T23（简历侧）落地（交付物卫生 + 内核散文本地化，不升规则版本）**（2026-09-26；明细归档 [10-01](docs/handoff-archive-2026-10-01.md) §1）
83. ✅ **T30 岗位池口径对齐（CLI `jobs stats` 增新鲜窗口 `freshWithin7d`）**（2026-09-26；明细归档 [09-26](docs/handoff-archive-2026-09-26.md)）
84. ✅ **T29 批次 6 三表面浏览器级验证（`/my`/partial/自选岗位 + 冷路由预热）**（2026-09-26；明细归档 [09-26](docs/handoff-archive-2026-09-26.md)）
85. ✅ **T33 内核散文收尾（规则 0.6→0.7，信号/面试题补 `facts` + 5 个 composer）**（2026-09-26；明细归档 [09-26](docs/handoff-archive-2026-09-26.md)）
86. ✅ **T13 + T14 + T16 落地（项目经历 / 量化句 / 岗位定向面试准备单，`RESUME_RULE_VERSION` 0.1→0.2）**（2026-09-26；明细归档 [09-27](docs/handoff-archive-2026-09-27.md)）
87. ✅ **T15 薄画像降级 + T22 扩岗位种子清单 + T19 融合画像可认领 + T18 求职者面试管道 + T20 推荐去重与翻页**（2026-09-27，`035b483`/`444f898`/`c0a3081`/`7f92df0`/`1b605da`；明细归档 [09-27](docs/handoff-archive-2026-09-27.md) §2）
88. ✅ **B2 自助解绑（`DELETE /profiles/:id` 级联删除，PRD:230 验收闭环）**（2026-09-27；明细归档 [09-27](docs/handoff-archive-2026-09-27.md) §4）
89. ✅ **CI 补 check-migrations + E2E 产物上传；T14 framework 标签排序修正（规则 0.7→0.8）**（2026-09-27；明细归档 [09-27](docs/handoff-archive-2026-09-27.md) §5）
90. ✅ **MCP 接入面落地（决策 #19，`apps/mcp` stdio + 4 只读工具 + fail-closed，24 测试）**（2026-10-01，`cc581b9`/`15a2bc3`/`d6fd559`/`8f61ce1`）
91. ✅ **T40 岗位池扩容：新增 We Work Remotely 源 + Greenhouse 种子 45→62**（2026-10-01；明细归档 [handoff-archive-2026-10-01](docs/handoff-archive-2026-10-01.md) §1）
92. ✅ **代码审计修复批次一：A3 `DemoRateKind` 单一事实源 + S4 `by-subject` IP 滑窗限流 + S2 投递推进越权**（2026-10-01，零迁移零内核改动；S2 选方案 A＝推进只对无主投递行生效，与 F11「认领即隐私开关」同口径）；明细见 [docs/handoff-archive-2026-10-13.md](docs/handoff-archive-2026-10-13.md) §1。
93. ✅ **S3 按主体撤回：公开申请 + 人工复核**（2026-10-01，迁移 016/017，CLI `removal` 命令组，设计见 [docs/design-profile-removal-request-20261001.md](docs/design-profile-removal-request-20261001.md)）；明细见 [docs/handoff-archive-2026-10-13.md](docs/handoff-archive-2026-10-13.md) §1。
94. ✅ **求职 Agent 阶段 1「求职工作台」落地**（2026-10-03，提交链 `d4c007c`(shared)→`33cdafe`(db)→`26dc25b`(db)→`cbed144`(storage)→`2efc5bb`(resume-core)→`500b994`(agent-core)→`269154c`(api)→`5f922ea`(report)→`4833af9`(e2e)→`a8b4ac4`(ci)→`5a69cb8`(config)→`80d234e`…`2e011e5`(docs)，补丁 `d32fc34`；按 [docs/设计-求职Agent-20261002.md](docs/设计-求职Agent-20261002.md) §6 实现「找→评→改→待投」四步、只准备不投递；契约/迁移 018–022/agent-core 内核/API 17 条/工作台 island/验证基线全见 [docs/handoff-archive-2026-10-11.md](docs/handoff-archive-2026-10-11.md) §1；PRD 新增 F12，阶段 2 未做项已登记 deferred；边界见 item95）

95. ✅ **决策 #20 拍板：求职 Agent 阶段 2/3 的边界**（2026-10-03，四条全部采纳助手建议：填完等用户点提交／快照暂不落库／复盘 ≥20 条带结果才生效／披露 AI 辅助投递；文档改动见 `87cb595` 及其后的措辞对齐提交）；明细见 [docs/handoff-archive-2026-10-13.md](docs/handoff-archive-2026-10-13.md) §1。

96. ✅ **工程债批次：测试守护补强 + 大文件拆分 + 报告 E2E 加固**（2026-10-03，`2c4605b`/`d7ecfcd`/`2a5beab`/`2ec0f25`/`8052ecf`；T4 双方言 parity / T3 报告页 token 守护 / T1 report 组件级单测 / Q1 API index.ts 2691 行→routes/ 13 域 / Q2 报告页拆分 / 报告 E2E 预热加固；report 149、api 226、report-render E2E 11/11；J6 异议邮箱同日闭环；明细见 [docs/handoff-archive-2026-10-11.md](docs/handoff-archive-2026-10-11.md) §1）
148. ✅ **用户批准的三项收口：BYOK「测试连接」复活、LLM 失败可判读、空态 CTA 改名**（2026-10-11，四 commit 链尾 `f7aefb8`；18 包 1597 例 / e2e 98 / e2e:agent 11×4；明细见 [docs/handoff-archive-2026-10-11.md](docs/handoff-archive-2026-10-11.md) §1）
147. ✅ **事件流分页：`GET /agent/runs/:id/events` + 工作台「加载更早」**（2026-10-11；仓储 `listLatestPage`/`listOlderPage` 哨兵行探 hasMore、游标＝事件 id 非时间戳；1581 例 / e2e 98 / e2e:agent 11；明细见 [docs/handoff-archive-2026-10-11.md](docs/handoff-archive-2026-10-11.md) §1）
146. ✅ **工作台事件流：取回窗口冻住 + 满屏重复一起修**（2026-10-10；`DESC,<写入序> LIMIT n` 再 reverse、相邻同质迁移折叠 ×N；1577 例 / e2e 97 / e2e:agent 11；明细见 [docs/handoff-archive-2026-10-11.md](docs/handoff-archive-2026-10-11.md) §1）
145. ✅ **BYOK 配置完成并打通生产 LLM 求职信；定死两个产品缺陷（测试连接死按钮 / 求职信失败不落日志）**（2026-10-10，内置浏览器操作、零代码；生产 200/4.17s/519 字、AI 披露行在；明细见 [docs/handoff-archive-2026-10-11.md](docs/handoff-archive-2026-10-11.md) §1）
144. ✅ **B4 生产冒烟实跑：搜岗链路复验通过、LLM 求职信暴露新卡点（上游 60s 超时）**（2026-10-10；PG `search_run_id` 修复在生产成立；明细见 [docs/handoff-archive-2026-10-11.md](docs/handoff-archive-2026-10-11.md) §1）
143. ✅ **L1 冒烟批次：release 重打剥 localhost + 生产搜岗链路验证 + PG search_run_id 修复 + 求职信 500 修复（空 evidenceRefs 协作条目）**（2026-10-10，**闭环 2026-10-11**；单测 1528；明细见 [docs/handoff-archive-2026-10-11.md](docs/handoff-archive-2026-10-11.md) §1）
142. ✅ **四层盘点批次：T1 五项全落地 + T2-6 生产 LLM env 完成 + T2-7 备份闭环（21M dump 验证可恢复）**（2026-10-09，**闭环 2026-10-11**；明细见 [docs/handoff-archive-2026-10-11.md](docs/handoff-archive-2026-10-11.md) §1）
140. ✅ **报告 E2E 一片红的真因：`localhost` 与 `127.0.0.1` 不是同一个地址**（2026-10-08，`34b6e5a`；baseURL 钉 IPv4 字面量 + 9 处 Cookie domain 同步；92 passed；明细见 [docs/handoff-archive-2026-10-11.md](docs/handoff-archive-2026-10-11.md) §1）
139. ✅ **接力核查：B 端方案四处前提与实测不符 + 031 上线顺序坑（合并前先生产执行迁移）**（2026-10-08，零代码；031 坑已闭环 10-08；明细见 [docs/handoff-archive-2026-10-11.md](docs/handoff-archive-2026-10-11.md) §1）
138. ✅ **Cron 消费收口三件套 T1–T3 + 文档同步 T4**（2026-10-07；删 cron-poll schedule / 认证清理每小时档 / A5 冗余依赖清理；cron-worker 5→10 例；明细见 [docs/handoff-archive-2026-10-11.md](docs/handoff-archive-2026-10-11.md) §1）
137. ✅ **T3：A5 冗余依赖清理**（2026-10-07，本批 item138③）
136. ✅ **T2：认证数据清理接入 cron-worker 每小时档**（2026-10-07，本批 item138②）
135. ✅ **T1：删 `cron-poll.yml` 的 schedule**（2026-10-07，本批 item138①）
134. ✅ **A 组工程债批次 3/3：迁移漂移守卫程序侧最小版**（2026-10-07，`9340bc2`+`1c3dda6`；`verifyRequiredColumns` 双方言 + `/health?deep=1` 缺列 503；明细见 [docs/handoff-archive-2026-10-11.md](docs/handoff-archive-2026-10-11.md) §1）
133. ✅ **A 组工程债批次 2/3：cron 心跳写口 + 读口**（2026-10-07，`1c3dda6`；process-job/agent-tick 每次尝试后 upsert `cron_heartbeat`、`/health?deep=1` 回全部心跳；明细见 [docs/handoff-archive-2026-10-11.md](docs/handoff-archive-2026-10-11.md) §1）
132. ✅ **A 组工程债批次 1/3：迁移 031 `cron_heartbeat` + storage 层**（2026-10-07，`0074a30`+`ca604c5`；双方言仓储 + upsert + 回滚断言；明细见 [docs/handoff-archive-2026-10-11.md](docs/handoff-archive-2026-10-11.md) §1）
131. ✅ **A 组工程债批次 0/3：sharp 依赖审计修复**（2026-10-07，`075d575`；root overrides 钉 sharp ≥0.35.5，audit 0 vulnerabilities；明细见 [docs/handoff-archive-2026-10-11.md](docs/handoff-archive-2026-10-11.md) §1）
130. ✅ **Cron Worker 消费实况对账（决策 #24 交叉验证）+ 登记「失败信号无读者」**（2026-10-07，零代码；实测 GH `*/15` 39h11m 交付 7/156 ≈4.5%、Worker 两次 `*/5` 均 Ok；明细见 [docs/handoff-archive-2026-10-11.md](docs/handoff-archive-2026-10-11.md) §1）
129. ✅ **接力迁移事故记录：生产缺哪笔迁移→可执行动作；顺手抓出 AGENTS.md 权限口径失效**（2026-10-07，纯文档；`/candidates` 免凭证路线关闭、030 独立复验、B5 四步固定动作；明细见 [docs/handoff-archive-2026-10-11.md](docs/handoff-archive-2026-10-11.md) §1）
128. ✅ **决策 #23 逐条声明核验：批次 1–3 全部落地**（2026-10-05，`91c2b2b`/`8bbc43b`…`bdb5952`/`55f43ef`；claim-core 反向通路 + ClaimVerifier island + e2e:agent 4 条真全栈；1405 passed；明细见 [docs/handoff-archive-2026-10-11.md](docs/handoff-archive-2026-10-11.md) §1）
127. ✅ **item126 落地：任意来源都能回标**（2026-10-05，`53f3262`+`7ed89e6`；PATCH 复用 `OutcomeFeedbackSchema`、时间戳服务端盖、`/my` 每行链画像页；1366 例；明细见 [docs/handoff-archive-2026-10-11.md](docs/handoff-archive-2026-10-11.md) §1）
126. ✅ **已由 item127 落地**（2026-10-05，同日；manual/report/extension 三种来源投递可回标）
125. ✅ **自纠：`/my` 的回标提示此前在对用户撒谎**（2026-10-05；origin 限定 agent、三向对照夹具）
124. ✅ **回标闭环：让「投递结果」第一次真的存在**（2026-10-05，`bb254e3`+`c576bbe`+`84904a0`；`GET /agent/runs/:id/submissions` + 工作台「已投与结果」+ `/my` 提示；明细见 [docs/handoff-archive-2026-10-11.md](docs/handoff-archive-2026-10-11.md) §1）
123. ✅ **内部 cron 端点停用 `?token=`**（2026-10-05，`3c671d3`；只认 `Authorization: Bearer`、形态已死钉 401；明细见 [docs/handoff-archive-2026-10-11.md](docs/handoff-archive-2026-10-11.md) §1）
122. ✅ **回访闭环：`/my` 列出「我发起的分析」**（2026-10-05，`2eb928c`+`cbef403`；排队任务可见、完成直接给报告链接；report 160、e2e 91；明细见 [docs/handoff-archive-2026-10-11.md](docs/handoff-archive-2026-10-11.md) §1）
121. ✅ **报告 E2E 抖动的根修 + 同步失败的可观测性**（2026-10-05，`5bff47e`+`5ee0b82`+`47df533`；data-hydrated 信号、ingestor 日志记 db code；1364 例；明细见 [docs/handoff-archive-2026-10-11.md](docs/handoff-archive-2026-10-11.md) §1）
120. ✅ **首跑等待的诚实化 + cron 密钥不再进 URL**（2026-10-05，`ce88c1d`+`aec2f64`；queued 相位 + `Authorization: Bearer`；1363 例；明细见 [docs/handoff-archive-2026-10-11.md](docs/handoff-archive-2026-10-11.md) §1）
119. ✅ **公开画像 API 的面试题收口**（2026-10-05，`5e775b2`+`b524e81`；`formatProfileForViewer` 未登录置空 + gating 如实报数；1361 例；明细见 [docs/handoff-archive-2026-10-11.md](docs/handoff-archive-2026-10-11.md) §1）
118. ✅ **审计开放项「我能自己做的」四条落地 + 新发现 A11**（2026-10-04，`2b973ca`/`0e57bdb`/`aca0199`/`1a91729`；A2 断言收敛 / A7 删零消费者导出 / report testTimeout / Dockerfile 漏 COPY；1358 例；明细见 [docs/handoff-archive-2026-10-11.md](docs/handoff-archive-2026-10-11.md) §1）
117. ✅ **审计报告 §7 复核刷新 + 第五条文档守护 A9（doc-anchors）**（2026-10-04，基线 `e9df14f`，零产品代码；1352 例 + 19 处锚点重钉；明细见 [docs/handoff-archive-2026-10-11.md](docs/handoff-archive-2026-10-11.md) §1）
109. ✅ **简历↔画像对账·PDF 文本抽取 spike（合成样本先行）**（2026-10-03；`tools/resume-pdf-spike/`，平均抽净率 97.9%，原文不留存代码级强制；明细见 [docs/handoff-archive-2026-10-11.md](docs/handoff-archive-2026-10-11.md) §1）
108. ✅ **扩展安全三项 S6/S7/S8**（2026-10-03，`4dec4e7`；manifest 域收窄 + onMessageExternal origin 白名单 + sw-relay host 白名单；extension 92；明细见 [docs/handoff-archive-2026-10-11.md](docs/handoff-archive-2026-10-11.md) §1）
107. ✅ **「未经本人授权」标注覆盖机器可读出口**（2026-10-03，`7c50647`；`formatProfile`/`toExportableProfile` + MCP 透传；明细见 [docs/handoff-archive-2026-10-11.md](docs/handoff-archive-2026-10-11.md) §1）
106. ✅ **CI #124 失败修复：GET /account/llm-config 契约改为始终 200**（2026-10-03，`4a316dd`→`fb120b2`→`ca0bddc`→`fedf013`；CVE-2026-93748 登记忽略 + Agnes key 历史 filter-repo 清除 + gitleaks allowlist；明细见 [docs/handoff-archive-2026-10-11.md](docs/handoff-archive-2026-10-11.md) §1）
105. ✅ **LLM 模型供给双轨 P0 全部落地**（2026-10-03，U1–U7 12 个英文原子提交已 push，链尾 `d57d6b8`；迁移 023–025 + admin/BYOK 端点 + llm-resolve 路由 + report 面板；storage 205/llm 46/api 249/report 155；明细见 [docs/handoff-archive-2026-10-11.md](docs/handoff-archive-2026-10-11.md) §1）
104. ✅ **决策 #21 全部拍板：LLM 模型供给定稿**（2026-10-03，纯文档；6 子问全采纳助手建议；明细见 [docs/handoff-archive-2026-10-11.md](docs/handoff-archive-2026-10-11.md) §1）
103. ✅ **LLM 供给设计 v2：内置＝Admin UI 管理 + BYOK＝用户自由设置**（2026-10-03，纯文档；参考 agent-world design-model-catalog；明细见 [docs/handoff-archive-2026-10-11.md](docs/handoff-archive-2026-10-11.md) §1）
102. ✅ **LLM 模型供给设计：内置（Agnes）+ BYOK（自带 Key）**（2026-10-03，纯文档；design-llm-model-provisioning + 决策 #21 五子问；明细见 [docs/handoff-archive-2026-10-11.md](docs/handoff-archive-2026-10-11.md) §1）
101. ✅ **A：LLM 求职信生成**（2026-10-03，`bc5c2d1`→`66832d7` 共 5 提交；`LlmCoverLetterProvider` 防臆造三层 + `POST /resumes/cover-letter` + report 入口；llm 24/api 18；明细见 [docs/handoff-archive-2026-10-11.md](docs/handoff-archive-2026-10-11.md) §1）
100. ✅ **B4 备份工具就绪**（2026-10-03，`tools/backup-db.sh`，`6b4f9cf`→`f6739b0` 共 4 提交；pg_dump custom format、保留最新 7 份、6543 检测；明细见 [docs/handoff-archive-2026-10-11.md](docs/handoff-archive-2026-10-11.md) §1）
99. ✅ **A1-A3：S5 LLM 脱敏 + 报告页证据卖点 + 审计状态同步**（2026-10-03，`7117b5a`→`14ef7ea` 共 3 提交；llm 20；明细见 [docs/handoff-archive-2026-10-11.md](docs/handoff-archive-2026-10-11.md) §1）
98. ✅ **赛道月度更新 + 两项 deferred 决策（需求整理期）**（2026-10-03，纯文档；`docs/市场与竞品更新-20261003.md` + 岗位池 13084 + waitlist/i18n 维持现状；明细见 [docs/handoff-archive-2026-10-11.md](docs/handoff-archive-2026-10-11.md) §1）
97. ✅ **Agent 两项产品口径调整**（2026-10-03，`0d64bd5`→`f26a96b`；AGENT_SCAN_POOL_LIMIT 800→2000 + mid 档标题/标签命中守卫，AGENT_RULE_VERSION 0.1→0.2；agent-core 32、15 包 1238；明细见 [docs/handoff-archive-2026-10-11.md](docs/handoff-archive-2026-10-11.md) §1）
