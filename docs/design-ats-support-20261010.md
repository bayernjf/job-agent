# ATS 支持现状与扩展路线（design-ats-support）

> 主题：扩展一键填充所面向的 ATS（Applicant Tracking System，申请人追踪系统）——概念定位、已支持清单、适配器架构、扩展路线。
> 状态：**现行**（2026-10-10 建立）。实施进度统一记 handoff，本文件只写设计与结论。

## 1. 概念定位（一句话）

ATS 是招聘方用来管理「岗位发布 → 申请收集 → 筛选 → 面试 → 录用」全流程的系统。求职者接触到的只是它**对外的一层**——公司招聘门户（如 `boards.greenhouse.io`、`jobs.lever.co`、`*.myworkdayjobs.com`）上的岗位页与申请表；投出去的简历/表单数据进入 ATS 后被解析成结构化候选人档案。

对 job-agent 的意义：
- **C 端（求职者）**：扩展在 ATS 申请表上做一键填充——ATS 是「投」的执行器；
- **B 端（招聘方）**：候选人库/简历对账（决策 #23）面对的数据也来自 ATS 侧；
- **岗位池**：Greenhouse/Lever 等 ATS 同时是公开岗位数据源（job-source 已接 Greenhouse/Lever 两源）。

## 2. 已支持清单（apps/extension/src/ats/）

适配器层是**注册式**的：`detect()` 识别当前页面属于哪个 ATS → `mapFields()` 把「可信画像（ExportableProfile）+ 本地补填（LocalFields）」映射为语义化 FillValue → `fill()` 写入页面 DOM。新增 ATS = 新增一个适配器文件 + 在 `ats/index.ts` 注册一行，面板与填充链路零改动。

| ATS | 类型 | 实现状态 | 能力边界 |
| --- | --- | --- | --- |
| **Greenhouse** | 现代 SaaS | ✅ 完整 + 真机验证 | 7 类标准字段 + 动机问题（why_company/why_role）识别；真实 Vercel Greenhouse 岗位页端到端实测通过（item114，2026-10-04） |
| **Lever** | 现代 SaaS | ✅ 完整 + 真机验证 | name 直填 + `questions[]` 数组（含 how_did_you_hear 语义防误填，2026-10-04 修正） |
| **Ashby** | 现代 SaaS | ✅ 完整 + 真机验证 | 2026-10-10 落地：系统字段 id 前缀 `_systemfield_`（name/email/resume 等）；GitHub/LinkedIn/Portfolio 等 URL 槽在不同公司被配置为**自定义问题**（Linear/Supabase 实测），按 label 文本定位（新增通用 `findFieldsByLabel`）；求职信只写动机/自我介绍类自定义问题（UUID id + label 命中 SUMMARY_HINTS），不写引流/国家/授权类；location 类字段暂不填（宁缺毋滥） |
| **Workday** | 大企业套件（招聘模块） | ✅ 完整 + 真机验证 | 2026-10-10 落地：字段定位键改用 **`data-automation-id`**（`legal-name-section_firstName`/`lastName`/`email`/`phoneNumber` 等；`index.ts findFields` 匹配源已加该属性）；Western 名/姓、邮箱、电话、地点、求职信按关键词匹配；**显式排除**中文名槽（`firstNameLocal`/`lastNameLocal`，EXCLUDE_LOCAL_NAME）与 country/type/extension 邻居，不自动上传简历、不勾 consent、不点提交（决策 #15/#20 硬边界）。真机验证：真实 GDIT guest 表单（`gdit.wd5.myworkdayjobs.com introduceYourself`）FAB 注入 + 加载画像 + 一键填充，`legal-name-section_firstName/lastName` 写入 "Demo"/"Dev"、中文名槽未误写。已知边界：Intel 等租户走账号制（Create Account，非 guest 可填表单）、NVIDIA/Tesla/Starbucks/Zoom/Adobe 跳 community.workday.com 死路——非本适配器缺陷，属租户配置差异 |

manifest `host_permissions` 目前为六条精确项：三 ATS 域 + `localhost:3000` + `127.0.0.1:3000` + 生产报告域（S6 收窄后，2026-10-03 item108）。

## 3. 扩展路线（按适配成本 × 目标用户价值排）

### 3.1 已落地：Ashby（2026-10-10）

海外科技公司使用率增长最快的「现代 ATS」阵营（与 Greenhouse/Lever 同类）；表单结构规整。已随本批次落地：`ats/ashby.ts` + 通用层 `findFieldsByLabel` + manifest（host_permissions 与 content_scripts 各加 `https://*.ashbyhq.com/*` 精确域）+ 6 个单测 + 真机验证（真实 `jobs.ashbyhq.com` 申请页 FAB 注入 + 面板识别 Ashby）。

### 3.2 下一梯队：中型 SaaS

| ATS | 说明 | 适配成本 |
| --- | --- | --- |
| Workable | 中型公司常用，公开岗位页结构相对规整 | 中 |
| SmartRecruiters | 结构规整、API 开放度好 | 中 |

### 3.3 大企业传统阵营（成本高、优先级低）

iCIMS、Oracle Taleo、SAP SuccessFactors、BambooHR（HR 套件内置招聘模块）：表单结构差异大、字段语义不统一、部分为多步 wizard，适配成本高，**仅在出现明确需求（真实用户投递数据指向这些域）时再做**。

### 3.4 触发条件与边界

- **不追求覆盖所有 ATS**：只按「真实用户投递行为数据」与「目标市场岗位集中度」选源扩；扩 ATS = 扩投递面，但每扩一个都增加 manifest 权限面（host_permissions 精确项），需与 S6 安全口径平衡——**新增 ATS 必须同步收窄到精确域，不得回退通配**；
- 触发条件＝出现以下任一：① 真实用户在当前不支持的 ATS 页尝试填充（产品内可埋点）；② 某 ATS 在岗位池/竞品数据中占比显著上升（如 Ashby 岗位数超过 Lever）；
- 与求职 Agent 阶段 2 的关系：半自动投递的填充执行依赖 ATS 适配器覆盖——扩 ATS 直接扩大「待投清单 → 一键填充」的可投面；但**决策 #20 硬边界不变**：填完停手、绝不自动点提交。

## 4. 已知记录（不重复展开）

- 扩展真机安装/试用/跨端同步：`apps/extension/INSTALL.md` + `apps/extension/README.md`（handoff item46）；
- Workday 真人验证法、CWS 上架素材：handoff「已知限制 / 待核实」；
- 扩展 E2E 机制与 ATS 模拟页：`design-extension-e2e-20260914.md`；
- 求职 Agent 阶段 2 的 ATS 填充链路细节：`设计-求职Agent-20261002.md` §10.4 / A2。
