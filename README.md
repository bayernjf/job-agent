# JobAgent

把开发者在 GitHub / Gitee 上留下的**行为痕迹**（commit、PR、Issue、项目演进）分析成**可信、可解释、可复核**的能力画像，用于技术招聘与应聘。一句话：**自述简历会被美化，行为痕迹不会**——JobAgent 做的就是把两者对齐，并让每一条结论都能点回证据。

生产地址：<https://app.job-agent.bayjf.com>（落地页 <https://job-agent.bayjf.com>）。界面与报告**中英双语**。

---

## 1. 产品

### C 端（应聘方）：一轮求职走得完

| 步骤 | 你能做什么 |
| --- | --- |
| **找** | 输入 GitHub/Gitee 用户名出画像；从岗位池要推荐——**只推荐源站这一轮还列着的岗位**，同一段 JD「下架一阵后又重新出现」会标出来（可复核的观察，不是判决）；或用自然语言**全网搜岗**（如「深圳的 Java 开发，坐班，可远程」）并把筛选条件存成预设 |
| **评** | 每条能力标签、每个真实性判据都挂 `evidenceRefs`；可解释的画像↔岗位匹配报告（命中技能、字段分值、岗位要求而画像无证据的缺口）；**质量闸挡下了哪些岗位、各因什么原因挡下，同样读得到** |
| **改** | 岗位定向简历 + 求职信：只在画像已有事实内重排，**不造事实**；LLM 润色可选且 fail-closed（无密钥就回落规则版） |
| **投** | 浏览器扩展在 Greenhouse / Lever / Ashby 等 ATS 页**一键填充**（均已真机验证；Workday 已具备字段定位能力、直渲染端到端仍待真人验证），**填完停手——提交由你本人点**（这是产品硬边界，不做自动投递）；不认同质量闸可以点名放行某一条，但它**只越过质量闸**：确认仍归你、每日限额照旧、放行留下可回放的审计记录 |
| **跟** | 投递记录与结果回写（`outcomeFeedback`）、面试计划表、`/my` 回访页（排队中的任务也看得见） |
| **复盘** | 「简历上这句话，你的 GitHub 撑得起吗」——声明逐条核验，输出 `supportable / partial / no_trace / insufficient_data` |

免注册的**演示模式**用临时身份进真实产品（每会话 3 次新分析、24h 有效），另有三个预置示例画像秒开。

### B 端（招聘方）：先看证据，再看人

- 人才库检索与筛选工作台（`/recruit`）：按技能、平台、真实性分级、置信度过滤，卡片直接显示真实性与已核验声明数。
- 单张画像的招聘方视角：原始证据外链、面试题、面试准备包导出（这些**只对登录用户解锁**，结论与匹配理由保持公开可回溯）。
- **发布自己的私有 JD，并按这条 JD 排候选人**——同屏给出「命中的人」与「已经排了的面试」。私有岗位**绝不进入 C 端公开岗位池**。
- 投递与面试记录按行归属：招聘方不能改写候选人自己的投递记录。

> 范围、优先级与不做什么以 [docs/PRD.md](docs/PRD.md) 为准；真实进度以 [handoff.md](handoff.md) 为准（本文件不记流水）。

---

## 2. 启动

### 2.1 本地跑起来（SQLite，最快路径）

```bash
nvm use                       # Node 版本以 .nvmrc 为准（当前 24.20.0）
pnpm install                  # pnpm workspaces，不用 npm/yarn
cp .env.example .env          # 环境变量权威模板（含注释与默认值）
pnpm -r build                 # api 的 dev 与 worker 的 start 都跑 dist/，先构建一次
pnpm migrate:up               # 建表（目标库优先级 --db > DB_PATH > data/job-agent.db）
pnpm --filter @jobagent/api dev         # API :3000
pnpm --filter @jobagent/worker start    # 分析任务消费者
pnpm --filter @jobagent/report dev      # 报告页/工作台 :4321
```

打开 <http://localhost:4321> 输入一个 GitHub 用户名即可。要一条命令拉起服务：

```bash
docker compose up -d                      # api / worker / report（SQLite）
docker compose --profile with-pg up -d     # 再加 Postgres :5432
```

**必需**：`GITHUB_TOKEN`（worker 采集用，fine-grained PAT 公开只读即可）。
**可选**：`GITEE_TOKEN`（只提额度，匿名可读公开数据）；`GITHUB_OAUTH_*` / `GITEE_OAUTH_*`（不配则该平台登录返回 501，其余功能照常）；`LLM_*`（不配则润色/求职信走规则版）。密钥只进 `.env`，绝不入库。

> 换过 Node 大版本后要重编译原生依赖：`pnpm rebuild -r better-sqlite3`（必须带 `-r`，否则静默 no-op）。

### 2.2 生产数据库（Postgres）

```bash
DB_DRIVER=postgres DATABASE_URL='postgresql://…?sslmode=no-verify' pnpm migrate:pg:status
DB_DRIVER=postgres DATABASE_URL='postgresql://…?sslmode=no-verify' pnpm migrate:pg:up
```

结构变更只走 `db/migrations/{sqlite,postgres}/NNN_verb_snake_case.sql` 对称目录（当前 37 对），规范见 [MIGRATION_CONVENTION.md](MIGRATION_CONVENTION.md)。**上线形态 C（Vercel + Supabase + Cloudflare DNS）的照勾步骤**在 [docs/部署执行单-形态C-20260921.md](docs/部署执行单-形态C-20260921.md)，通用 runbook 见 [docs/deployment-runbook-20260920.md](docs/deployment-runbook-20260920.md)。队列消费由 `apps/cron-worker`（Cloudflare Worker Cron，`*/5` 档）驱动，部署用 `pnpm --filter @jobagent/cron-worker deploy`（wrangler secret 注入凭证）。

### 2.3 浏览器扩展

```bash
pnpm --filter @jobagent/extension build      # 产出 dist/，Chrome 开发者模式「加载未打包」
EXTENSION_API_BASE=https://<app-origin>/api EXTENSION_SITE_ORIGIN=https://<app-origin> \
  pnpm --filter @jobagent/extension release  # CWS/自分发用的 release zip
```

安装步骤与 ATS 支持矩阵见 [apps/extension/INSTALL.md](apps/extension/INSTALL.md)。

### 2.4 交付前自检

```bash
pnpm -r typecheck && pnpm -r build && pnpm -r test
bash tools/check-migrations.sh
bash tools/preflight.sh            # 五阶段一键预检；--e2e 追加三套 Playwright，--deploy 追加产物闸
```

E2E 分三套：`pnpm e2e`（报告页，mock API）、`pnpm e2e:agent`（求职工作台**真全栈**：真 API + 真 SQLite + 真报告页）、`pnpm e2e:extension`（扩展加载 unpacked MV3）。日常命令与提交规范以 [AGENTS.md](AGENTS.md) / [CONTRIBUTING.md](CONTRIBUTING.md) 为准。

---

## 3. 架构概览

### 3.1 一次分析的数据流

```
用户名 ─▶ API（Hono + Zod 校验）──▶ analysis_jobs(queued)   ← 立即返回 jobId
                                          │
        apps/cron-worker（Cloudflare Worker Cron */5）叫醒消费者
                                          ▼
                        Worker 认领 ─▶ github-source / gitee-source / semantic-source
                                          │  产出证据源无关的 AnalyzerInput
                                          ▼
                        analyzer-core（纯函数 + 规则版本 RULE_VERSION，当前 0.9）
                                          ▼
        profiles（不可变快照）+ evidence ─▶ 报告页 SSR 直读只读 storage
```

关键不变量：一次分析**只发布一份可分享结论**（进度走 job stage，不允许先出半成品再升级同一个链接）；任一层失败必须显式标注缺失，**禁止输出"看似完整"的报告**；画像存快照而非实时重算，避免源数据变化导致已分享结论漂移。

### 3.2 分层与目录（14 packages + 7 apps）

| 层 | 位置 | 职责 |
| --- | --- | --- |
| 契约 | `packages/shared` | `AbilityProfile` / `EvidenceItem` / `JobPosting` / 各 API 请求体的 Zod 单一事实源；内核散文的本地化 composer 也在这 |
| 持久化 | `packages/storage` | 仓储接口 + SQLite/Postgres 双实现 + 迁移器；**方言差异只允许出现在这一层内部** |
| 证据源 | `github-source`、`gitee-source`、`semantic-source` | Octokit（GraphQL 批量 + REST 补）、Gitee v5 REST-only、L3 不 clone 的语义采集，都产 `AnalyzerInput` |
| 内核（纯函数） | `analyzer-core`、`semantic-core`、`resume-core`、`claim-core`、`agent-core` | 真实性分级与画像装配；成熟度/技术栈；岗位定向简历与受约束润色安全层；简历声明逐条核验；求职任务状态机与匹配闸 |
| 岗位与搜岗 | `job-source`、`search-source` | 7 个岗位源适配器 + 增量同步去重；指令式全网搜岗（Tavily 主通道 + 意图解析 + JD 抽取） |
| 供给 | `llm`、`ui-tokens` | OpenAI 兼容端口 + Fake（内置目录 / BYOK 双轨，凭证只在 env）；设计 token 单一事实源 |
| 进程 | `apps/api`、`apps/worker`、`apps/cron-worker` | HTTP 面与求职 Agent 编排壳；队列消费者；定时器（`*/5` 档驱动 process-job / agent-tick / search-tick / watchdog / digest） |
| 表面 | `apps/report`、`apps/extension`、`apps/cli`、`apps/mcp` | Astro + React islands（报告页、工作台、`/recruit`、`/my`、admin）；MV3 扩展；批量分析与运维 CLI；只读 MCP 接入面 |

### 3.3 四条硬边界

1. **内核不做 I/O**：`analyzer-core` 等纯函数不发请求、不读库、不读文件，输入是采集后的结构化数据——这样才能对固定夹具做确定性单测、才能版本化复现。
2. **DB 访问只走 `packages/storage`**：业务模块不写裸 SQL、不感知方言，`createStorage()` 按 `DB_DRIVER` 切换。
3. **结论必须挂证据**：无证据不下结论，证据不足输出 `insufficient_data`；真实性用「分级 + 信号 + 置信度」，不出单一「真实度百分比」。
4. **不 clone、不执行任何仓库代码**：只走平台公开 API 或本人 OAuth 授权数据；更深的分析（L2 起）需要先过隔离沙箱与合规闸门。

对外可见性的口径（哪些内容登录才可见、JSON API 同口径收口）、i18n 与设计 token 约定、迁移与提交纪律，全部集中在 **[AGENTS.md](AGENTS.md)**；缓做事项与重启触发条件在 **[docs/deferred-items.md](docs/deferred-items.md)**；按场景找文档看 **[docs/README.md](docs/README.md)**。
