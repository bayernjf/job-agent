# JobAgent 部署 / 上线 Runbook

> 状态：**现行（运维操作手册）**，2026-09-20（2026-09-21 随 #14/配额拍板更新）。本文档只讲"怎么部署、上线前要准备什么、上线后怎么验"。部署形态 C、demo 配额 3/24h、#14 产品侧姿态均已拍板（见 [待拍板决策清单 #14](待拍板决策清单-20260910.md) 与 [handoff](../handoff.md) item37）；生产域名最终确认、LLM 厂商、法务最终意见仍为外部项，文中显式标注。
>
> **部署形态已拍板为形态 C（Vercel + Supabase + Cloudflare，见 §4-C，2026-09-20）**；形态 A/B（Docker 自托管）保留为自托管备选。形态 C 的代码改造已完成并通过本地 Vercel 构建验证，但**尚未在真实 Vercel/Supabase 项目上部署实测**。
>
> 已验证 / 未验证边界（重要）：
> - ✅ 已在本机用 Docker 实测：三镜像（api/worker/report）构建、SQLite 与 Postgres 双栈运行时、worker 轮询、demo 闸、真实分析、共享卷、空 PG 并发首迁移（advisory lock 串行化），arm64（Apple Silicon）与 amd64 均跑过（见 handoff item13/已知限制）。
> - ❌ **未在生产/staging 实测**：真实域名 + HTTPS 反向代理拓扑、跨子域 CORS 带凭证、report SSR 服务端取数的 API 基址在反代后的可达性（见 §4 与 §11）。本文档给的是配置要点与待验清单，不是已验证的生产配方。

---

## 1. 组件与运行架构

| 组件 | 镜像 target | 端口 | 职责 |
| --- | --- | --- | --- |
| `api` | `api` | 3000 | Hono HTTP 服务：触发分析、查询任务/画像、auth、demo、岗位/简历/招聘方端点 |
| `worker` | `worker` | —（无端口） | 轮询 `analysis_jobs` 消费分析任务；**缺 `GITHUB_TOKEN` 时 fail-fast 退出（设计如此）** |
| `report` | `report` | 4321 | Astro SSR 报告站 + React islands；既服务浏览器页面，也在 SSR 阶段向 api 取数 |
| `db` | `postgres:16-alpine`（compose profile `with-pg`） | 5432 | 生产数据库；本地默认用 SQLite（卷内文件） |

- **数据库迁移是自动的**：服务以非只读方式打开存储时 `autoMigrate` 默认为 `true`（`packages/storage/src/storage.ts`：`config.autoMigrate ?? !config.readonly`）。api/worker/report 启动即应用迁移；Postgres 多实例并发首迁移由 advisory lock 串行化（`141ee9a`），SQLite 靠共享卷单文件。
- SQLite 数据落在容器 `/app/data`（compose 命名卷 `appdata`）；node-runtime 镜像已 `mkdir -p /app/data`。
- CLI（`jobagent`）在 api/worker 镜像内可用：node-runtime 阶段 `COPY` 了整个 `apps/`，`pnpm -r build` 已构建 `apps/cli/dist`，容器内入口为 `node apps/cli/dist/index.js`。

## 2. 上线前必须准备 / 拍板的清单

| # | 事项 | 说明 | 现状 |
| --- | --- | --- | --- |
| 1 | **部署形态** | ✅ 已拍板：**形态 C（Vercel + Supabase + Cloudflare，§4-C）**；A/B 为自托管备选 | 形态 C 代码就绪，未真实部署 |
| 1b | **Vercel 计划** | 每分钟消费分析任务依赖 per-minute cron——**Hobby 计划 cron 每天只能跑 1 次（更频繁表达式直接部署失败），需 Pro（$20/月）**；函数时长两档均为 300s 上限，够用 | ⏳ 待开通/确认 |
| 2 | **生产域名 + HTTPS 证书** | 形态 C 占位 `app.job-agent.bayjf.com`（Vercel 自动签证书）；落地页继续在 Cloudflare Pages `job-agent.bayjf.com` | ⏳ 域名占位，待绑定 |
| 3 | **Supabase Postgres** | 建项目（区域建议与 Vercel region `hnd1` 东京一致）；函数用 6543 事务池化串，迁移走 5432 | 代码就绪，项目未建 |
| 4 | **GitHub OAuth App（生产）** | 回调 `https://<域名>/auth/github/callback`，scope `user:email` | 仅有本地 App（id 3868123，仅 localhost） |
| 5 | **Gitee OAuth 应用（生产）** | Gitee→设置→第三方应用，回调 `https://<域名>/auth/gitee/callback`，scope `user_info` | ❌ 连本地都还没建真实应用 |
| 6 | **`AUTH_STATE_SECRET`** | 生产多实例必须固定一个随机 HMAC 密钥；留空则进程内随机、重启使进行中登录失效 | 未生成 |
| 7 | **`GITHUB_TOKEN` / `GITEE_TOKEN`** | worker 必需 GitHub 凭证（生产建议 GitHub App）；Gitee 匿名可读公开数据、token 仅提额 | 本地 `.env`，不入库 |
| 8 | **`DEMO_IP_SALT`** | 生产固定随机盐，否则重启后 IP 限流窗口失效 | 未生成 |
| 9 | **demo 配额 / TTL 数值** | ✅ 2026-09-21 已拍板：每会话 3 次分析、TTL 24h（融合扣 2）；代码默认值已对齐 | ✅ 已落地 |
| 10 | **LLM（可选）** | 不填则简历走纯规则版；启用需 OpenAI 兼容端点 + `LLM_API_KEY`/`LLM_MODEL`，费用与厂商自定 | 默认关闭 |
| 11 | **镜像 registry** | 镜像目前未推任何 registry；要么服务器本地 build，要么先推 registry | 未做 |
| 12 | **合规（#14）** | ✅ 产品侧姿态 2026-09-21 已拍板：长期留存+应求删除、链接不自动过期+应求撤销（异议 mailto，上线前须有人值守该邮箱）；法务最终意见仍待外部 | ✅ 产品侧已定 |

> 密钥只存在于服务端环境变量 / 密钥管理，**绝不入 Git、构建产物或前端**；仓库根 `.env` 已被 gitignore。

## 3. 生产环境变量清单

完整权威模板是仓库根 [`.env.example`](../.env.example)（含注释与默认值）。下表只列**生产部署时需要特别处理**的项。

| 变量 | 生产必需性 | 生产建议 / 注意 |
| --- | --- | --- |
| `DB_DRIVER` | 必需 | 生产 `postgres` |
| `DATABASE_URL` | 用 PG 时必需 | `postgres://user:pass@db:5432/jobagent`（compose 内主机名 `db`） |
| `GITHUB_TOKEN` | worker 必需 | 生产建议换 GitHub App installation token；缺失 worker 退出 |
| `GITEE_TOKEN` | 可选 | 仅提高匿名限额 |
| `GITHUB_OAUTH_CLIENT_ID/SECRET` | 要 GitHub 登录则必需 | 生产 OAuth App 凭证；不填登录路由 501、其余功能正常 |
| `GITEE_OAUTH_CLIENT_ID/SECRET` | 要 Gitee 登录则必需 | 同上，与 GitHub 共用下面三项 |
| `AUTH_STATE_SECRET` | **生产必需** | 固定随机值，多实例共享 |
| `AUTH_CALLBACK_BASE_URL` | 反代/跨子域必需 | `https://<域名>`，不带尾斜杠；留空按请求 Host 推导 |
| `AUTH_AFTER_LOGIN_URL` | 可选 | 登录成功落地页，默认 `/` |
| `AUTH_SESSION_TTL_MS` | 可选 | 默认 30 天 |
| `CORS_ALLOW_ORIGINS` | 形态 B 必需 | 报告站精确来源白名单（逗号分隔）；**留空则 `origin:'*'` 且不发凭证，与登录 Cookie 不兼容** |
| `TRUST_PROXY` | 反代后**必需 `true`** | 才采信 `X-Forwarded-For` 首段做 IP 限流 |
| `DEMO_IP_SALT` | **生产必需** | 固定随机盐 |
| `DEMO_*`（配额/TTL/并发） | 用默认或拍板值 | 数值未拍板前是建议默认；`DEMO_FUSION_QUOTA_COST` 默认 2 |
| `JOB_HTTP_PROXY` | 视网络 | 服务端换 OAuth token / 岗位采集走代理；也回退 `HTTPS_PROXY/HTTP_PROXY` |
| `LLM_*` | 可选 | 不填=纯规则简历；填了才启用润色 |
| `PUBLIC_API_BASE` | **构建期**变量 | 见 §4，极易踩坑：它在 `docker build` 时固化，不是运行时；**形态 C 不用设**（自动回退同域 `/api`） |
| `CRON_SECRET` | 形态 C **生产必需** | serverless 内部 cron 端点（`/api/internal/cron/*`）的共享密钥；配了就要求 cron 路径带 `?token=`（常量时间比较），不配仅信任 Vercel 的 `x-vercel-cron` 头。生成：`openssl rand -hex 32` |

## 4. 两种部署形态（A/B 未拍板，并列给出）

报告站对 api 有两类调用，配置时都要满足：
1. **浏览器 fetch**（AccountMenu、Analyze、认领、推荐、简历、demo 等）：路径前缀 `/auth/*`、`/analyze`、`/profiles/*`、`/job-postings/*`、`/jobs/*`、`/resumes/*`、`/demo/*`、`/candidates`、`/applications`。
2. **report 的 SSR 服务端取数**（如证据明细、登录态解析）：在 Node 端发请求，**不能用相对 URL**，需要一个服务端可达的 api 绝对地址。

### 形态 A：同域反向代理（推荐）

- 一个域名（如 `app.example.com`），TLS 在反代终止；页面与浏览器 API 同源，反代按前缀把 API 路径转发给 api 容器，其余转发给 report。
- 浏览器同源 → **不需要 CORS、不需要跨子域 Cookie 配置**；`PUBLIC_API_BASE` 对浏览器可留空。
- **但 SSR 服务端取数仍需绝对地址**：建议给 report 一个集群内可达的 api 地址（如 `http://api:3000`）。当前 `PUBLIC_API_BASE` 同时被浏览器与 SSR 使用，二者对"留空"的诉求冲突——**这是上线前必须在 staging 实测并定案的点**（可能需要分开"浏览器公开基址 / 服务端内部基址"两个变量，属代码小改动，验证后再做，勿在生产猜）。
- 反代后设置 `TRUST_PROXY=true`、`AUTH_CALLBACK_BASE_URL=https://app.example.com`。
- 反代需转发的 API 前缀见上面清单 1；并转发 OAuth 回调 `/auth/github/callback`、`/auth/gitee/callback`。

### 形态 B：跨子域

- 如 `app.example.com`（report）+ `api.example.com`（api）。
- 必须：全站 HTTPS；`CORS_ALLOW_ORIGINS=https://app.example.com`（精确，不能是 `*`，否则带凭证请求被拒）；api 对命中来源回 `Access-Control-Allow-Credentials`；`AUTH_CALLBACK_BASE_URL=https://api.example.com`。
- `PUBLIC_API_BASE=https://api.example.com` 必须在**构建 report 镜像时**作为 build arg 传入（`import.meta.env.PUBLIC_*` 构建期固化，运行时改 env 无效）。
- `TRUST_PROXY=true`。

> 形态 A/B 都要求 HTTPS（登录会话是 HttpOnly Cookie），属自托管备选；**生产已拍板走形态 C**。

### 形态 C：Vercel（报告页 + API 同域）+ Supabase（Postgres）+ Cloudflare（落地页/DNS）—— ✅ 已拍板

**拓扑**

```text
Cloudflare Pages   job-agent.bayjf.com        落地页（独立仓 job-agent-landing，保持现状）
Cloudflare DNS     app.job-agent.bayjf.com    CNAME 到 Vercel（占位域名，可改）
        └─> Vercel 单项目（Root Directory = apps/report，region hnd1 东京）
              ├─ /            Astro SSR 报告页（Node serverless function，maxDuration 300s）
              ├─ /api/*       同域挂载 Hono API（apps/report/src/pages/api/[...slug].ts 转发）
              └─ /api/internal/cron/*   Vercel Cron 调用（process-job / cleanup）
Supabase           Postgres（区域与 hnd1 对齐）：6543 事务池化给函数，5432 给本地迁移
（无常驻 Worker）  分析任务由 Vercel Cron 每分钟调用一次 process-job，每次认领处理一个 job
```

**为什么这样切**：报告页 SSR 直读 storage（Node 侧 TCP 连 Postgres），Cloudflare Workers V8 无直连 PG 能力，故报告页+API 放 Vercel Node runtime；同域挂载 `/api` 后浏览器天然同源，**无需 CORS、无需跨子域 Cookie、`PUBLIC_API_BASE` 不用设**（`browserApiBase()` 在 Vercel 环境自动回退 `/api`）；SSR 直连库也不存在形态 A 的"浏览器/SSR 基址冲突"。落地页是纯静态站，继续留在 Cloudflare Pages。

**Vercel 项目设置（控制台，一次性）**

1. Import 本仓，**Root Directory 设为 `apps/report`**（`vercel.json` 在该目录；构建命令已在其中写好，会先 `pnpm --filter @jobagent/report... build` 构建 workspace 依赖）。
2. Framework Preset = Astro；Node 版本 24（与 `.nvmrc` 一致）；Region 选东京 `hnd1`（与 Supabase 区域对齐，且海外直连 GitHub/Gitee，**不需要 `JOB_HTTP_PROXY`**）。
3. Environment Variables：按 `.env.example` 末尾「生产部署：Vercel + Supabase（形态 C）」段逐项填——`DB_DRIVER=postgres`、`DATABASE_URL`（6543 池化串）、**`DB_AUTO_MIGRATE=false`**（迁移只走本地 5432 流程）、**`API_MOUNT_PREFIX=/api`**（决定对外 OAuth 回调 URI 与临时 Cookie Path，漏配会导致登录回调 404）、`GITHUB_TOKEN`/`GITEE_TOKEN`、OAuth client/secret、`AUTH_STATE_SECRET`、`AUTH_CALLBACK_BASE_URL=https://<域名>`（不含 `/api`）、`TRUST_PROXY=true`、`DEMO_IP_SALT`、`CRON_SECRET`。
4. Cron：`apps/report/vercel.json` 已声明两条——`* * * * *` 调 `/api/internal/cron/process-job?token=...`（每分钟认领处理一个分析任务）、`17 3 * * *` 调 cleanup（清过期 demo/认证数据）。**部署前必须把路径里的 `REPLACE_WITH_CRON_SECRET` 换成真实 `CRON_SECRET`**（或改用 Vercel 控制台的 Cron 管理界面填）。
5. **计划限制（2026-09 核实）**：函数时长 Hobby/Pro 默认与上限均含 300s（Pro 可调到 800s），单任务处理够用；但 **Cron 在 Hobby 计划每天只能跑 1 次，每分钟表达式会直接导致部署失败——生产需 Pro 计划**。Hobby 只能用于演示（把 process-job 改成日频，队列基本不可用）。
6. 自定义域名：Vercel 项目绑定 `app.job-agent.bayjf.com`（占位），再到 Cloudflare DNS 加 CNAME（建议 DNS-only / 关闭橙云代理，让 Vercel 直接终结 TLS，避免边缘与函数区域链路的不确定行为；如坚持开橙云需实测）。

**Supabase 开库与首次迁移**

1. 建项目，区域选与 `hnd1` 同区（东京/新加坡就近）；拿到两条连接串：Session pooler/直连 **5432**、Transaction pooler **6543**（形如 `.env.example` 中的占位）。
2. 函数运行时用 **6543 + `?pgbouncer=true&sslmode=require`**：连接工厂检测到 6543 或 `pgbouncer=true` 会自动 `prepare:false`（PgBouncer 事务模式不支持 prepared statements），检测到 `sslmode=require/verify-ca/verify-full` 会显式开 TLS。
3. **首次迁移在本地用 5432 串跑**，不要让 serverless 冷启动碰 DDL：
   ```bash
   DB_DRIVER=postgres DATABASE_URL='postgresql://...5432...' pnpm migrate:pg:up
   ```
   Vercel 环境显式设 **`DB_AUTO_MIGRATE=false`** 关闭函数冷启动自动迁移（未设时非只读打开默认 autoMigrate；该开关只接受 `true`/`false`），后续结构变更一律先发迁移、再发代码。
4. Supabase 控制台开启自动备份（Pro 含 PITR）；表清单见 §5。

**岗位日更 / HN 月更不进 serverless**：`jobs sync`（五源、耗时长、易超 300s）由 **GitHub Actions 定时 workflow [`.github/workflows/jobs-sync.yml`](../.github/workflows/jobs-sync.yml) 跑 CLI**（已落地）：UTC 每天 18:17 跑四源日更（stale 7d）、每月 1 日 18:42 跑 HN（`--stale-days 35`），支持 Actions 面板手动触发（daily / hn-monthly 二选一），并发组防止重叠。**上线前需在仓库 Settings → Secrets and variables → Actions 配 `DATABASE_URL`**：用 Supabase **5432 Session pooler/直连串**（Actions 是长生命周期非 serverless 客户端，且任务含多语句 upsert；不要用 6543 事务池化串），workflow 已固定 `DB_DRIVER=postgres`、`DB_AUTO_MIGRATE=false`（只写数据不碰 DDL）；可选 `JOB_HTTP_PROXY`（GitHub runner 在海外直连各源，通常不需要）。demo/auth 清理已由 Vercel Cron cleanup 端点承担，无需再跑 CLI。

**本地/Docker 不受影响**：`astro.config.mjs` 仅在检测到 `VERCEL` 或 `ASTRO_ADAPTER=vercel` 时切到 Vercel 适配器，本地与 Docker 仍是 `@astrojs/node` standalone；本地验证 Vercel 产物：`ASTRO_ADAPTER=vercel pnpm --filter @jobagent/report build`。

## 5. 数据库

- 生产用 Postgres：`DB_DRIVER=postgres` + `DATABASE_URL`；compose 用 `--profile with-pg` 起本地库，托管库则不需要 `db` 服务。
- 迁移随服务启动自动应用，无需单独迁移步骤；若希望显式控制，可在发布流程里先用 cli 跑一次（cli 非只读打开同样 autoMigrate）。
- 建议：托管 PG 开自动备份；定期备份 `profiles/evidence/analysis_jobs/accounts/auth_sessions/job_postings/waitlist` 等表。
- SQLite 仅适合本地 / 单机 demo；多实例或对外服务用 Postgres。
- **形态 C（Supabase）连接串分工**：serverless 函数用 Transaction pooler **6543**（`?pgbouncer=true`，连接工厂自动关 prepared statements）并设 `DB_AUTO_MIGRATE=false`；迁移/DDL 用 Session pooler/直连 **5432**。两者都建议带 `sslmode=require`。不要把 5432 串给函数（serverless 高频冷连接会耗尽直连会话），也不要让 6543 串跑迁移（池化下 advisory lock/DDL 行为不可靠）。

## 6. Docker 部署步骤（本地 / staging 已验证；生产域名相关未验证）

```bash
# 1) 准备配置（密钥不入库）
cp .env.example .env
#   编辑 .env：填本节 §2/§3 的生产项（DB_DRIVER=postgres、DATABASE_URL、OAuth、AUTH_STATE_SECRET、TRUST_PROXY 等）

# 2) 构建（形态 B 记得在 build report 时传 --build-arg PUBLIC_API_BASE=https://api.example.com）
docker compose --profile with-pg build

# 3) 起库 + 服务（compose 会自动加载根目录 .env）
DB_DRIVER=postgres \
DATABASE_URL=postgres://jobagent:jobagent@db:5432/jobagent \
docker compose --profile with-pg up -d

# 4) 看状态 / 日志
docker compose ps
docker compose logs -f api worker report
```

现网 `docker-compose.yml` 的 api/worker/report 三个服务目前只透传了 `DB_*` 与 `GITHUB_TOKEN`。**启用登录/demo/LLM/跨域时，需要把对应 env 透传进容器**。可新增一个 `docker-compose.prod.yml` override（不要把真实密钥写进去，用 `${VAR}` 从 `.env` 读），示例片段：

```yaml
# docker-compose.prod.yml —— 示例：复制后按域名/形态填写；本片段不包含任何密钥
services:
  api:
    environment:
      DB_DRIVER: postgres
      DATABASE_URL: ${DATABASE_URL}
      GITHUB_TOKEN: ${GITHUB_TOKEN}
      GITEE_TOKEN: ${GITEE_TOKEN:-}
      GITHUB_OAUTH_CLIENT_ID: ${GITHUB_OAUTH_CLIENT_ID}
      GITHUB_OAUTH_CLIENT_SECRET: ${GITHUB_OAUTH_CLIENT_SECRET}
      GITEE_OAUTH_CLIENT_ID: ${GITEE_OAUTH_CLIENT_ID:-}
      GITEE_OAUTH_CLIENT_SECRET: ${GITEE_OAUTH_CLIENT_SECRET:-}
      AUTH_STATE_SECRET: ${AUTH_STATE_SECRET}
      AUTH_CALLBACK_BASE_URL: ${AUTH_CALLBACK_BASE_URL}
      CORS_ALLOW_ORIGINS: ${CORS_ALLOW_ORIGINS:-}
      TRUST_PROXY: "true"
      DEMO_IP_SALT: ${DEMO_IP_SALT}
      JOB_HTTP_PROXY: ${JOB_HTTP_PROXY:-}
      LLM_API_KEY: ${LLM_API_KEY:-}
      LLM_BASE_URL: ${LLM_BASE_URL:-}
      LLM_MODEL: ${LLM_MODEL:-}
  worker:
    environment:
      DB_DRIVER: postgres
      DATABASE_URL: ${DATABASE_URL}
      GITHUB_TOKEN: ${GITHUB_TOKEN}
      GITEE_TOKEN: ${GITEE_TOKEN:-}
      JOB_HTTP_PROXY: ${JOB_HTTP_PROXY:-}
  report:
    environment:
      DB_DRIVER: postgres
      DATABASE_URL: ${DATABASE_URL}
    # 形态 B：PUBLIC_API_BASE 是构建期变量，应在 build 阶段用 build arg 传入，而非在此运行时设置
```

用法：`docker compose -f docker-compose.yml -f docker-compose.prod.yml --profile with-pg up -d`。
（是否把该 override 文件作为 `*.example.yml` 入库，待形态拍板后再定，避免固化未决拓扑。）

## 7. 定时任务（cron）

容器内用 worker（或 api）镜像跑 CLI，命令前缀 `node apps/cli/dist/index.js`。

| 任务 | 命令（容器内） | 建议频率 | 说明 |
| --- | --- | --- | --- |
| 岗位日更同步 | `node apps/cli/dist/index.js jobs sync` | 每天 1 次 | 默认四源 remoteok/remotive/greenhouse/lever，`JOB_SYNC_SOURCES` 可调 |
| HN「Who is hiring」 | `node apps/cli/dist/index.js jobs sync --source hn_whoishiring --stale-days 35` | 每月 1 次 | 月度自由文本源，markStale 用 35 天阈值 |
| demo 数据清理 | `node apps/cli/dist/index.js demo cleanup --retain-hours 24` | 每天 1 次 | 清过期/退出超期演示会话与限流事件 |
| 认证数据清理 | `node apps/cli/dist/index.js auth cleanup --retain-hours 24 --account-retain-hours 720` | 每天 1 次 | 清过期会话（留 24h）与无活会话的未认领账号（留 30d） |

宿主机 cron 示例（频率为建议值，可按运维策略调整）：

```cron
17 3 * * *  cd /opt/jobagent && docker compose -f docker-compose.yml -f docker-compose.prod.yml run --rm --no-deps worker node apps/cli/dist/index.js jobs sync
23 4 1 * *  cd /opt/jobagent && docker compose -f docker-compose.yml -f docker-compose.prod.yml run --rm --no-deps worker node apps/cli/dist/index.js jobs sync --source hn_whoishiring --stale-days 35
41 4 * * *  cd /opt/jobagent && docker compose -f docker-compose.yml -f docker-compose.prod.yml run --rm --no-deps worker node apps/cli/dist/index.js demo cleanup --retain-hours 24
47 4 * * *  cd /opt/jobagent && docker compose -f docker-compose.yml -f docker-compose.prod.yml run --rm --no-deps worker node apps/cli/dist/index.js auth cleanup --retain-hours 24 --account-retain-hours 720
```

> 清理本体（`demo cleanup` / `auth cleanup`）代码已落地并测试；**生产 cron 的实际调度随部署补**（handoff 已知限制）。频率是建议默认，非拍板值。

**形态 C（Vercel，已拍板）的调度映射**：

| 任务 | 形态 C 调度方式 | 端点 / 命令 |
| --- | --- | --- |
| 分析任务消费 | **Vercel Cron** 每分钟（需 Pro 计划） | `GET /api/internal/cron/process-job?token=<CRON_SECRET>`，每次认领并处理**一个** job；内置 5min 僵尸回收、demo 并发闸（超闸 defer 不烧 attempts） |
| demo + auth 清理 | **Vercel Cron** 每天 03:17 | `GET /api/internal/cron/cleanup?token=<CRON_SECRET>&task=all`（task=demo/auth/all，默认 all；保留窗口 24h / 30d） |
| 岗位日更 / HN 月更 | **GitHub Actions 定时 workflow 跑 CLI**（已落地 `.github/workflows/jobs-sync.yml`，每日 18:17 UTC / 每月 1 日 18:42 UTC，可手动触发） | 同左表 CLI 命令；需配 Actions secret `DATABASE_URL`（5432 串）；不塞进 serverless（时长/预算不可控） |

鉴权：配了 `CRON_SECRET` 则必须带 `?token=`（常量时间比较）；未配时仅信任 Vercel 边缘下发的 `x-vercel-cron: 1` 头（外部无法伪造该头），仅适合临时调试。端点在配置缺失（如无 token）时返回 500，不伪装成功。

## 8. OAuth 生产配置要点

- GitHub OAuth App：回调 `https://<域名>/auth/github/callback`，scope `user:email`。
- Gitee 第三方应用：回调 `https://<域名>/auth/gitee/callback`，scope 固定 `user_info`（仅公开身份 id/login/name/头像，邮箱可能为空）。协议三处与 GitHub 的差异见 [design-gitee-oauth-20260919](design-gitee-oauth-20260919.md) §2。
- **形态 C 注意**：API 同域挂在 `/api` 下，Vercel 环境设 `API_MOUNT_PREFIX=/api` 后，服务端拼出的 redirect_uri 与临时 Cookie Path 自动带前缀；OAuth App 里登记的回调为 `https://app.<域名>/api/auth/github/callback`、`/api/auth/gitee/callback`；`AUTH_CALLBACK_BASE_URL=https://app.<域名>`（不含 `/api`）。
- 两平台共用 `AUTH_STATE_SECRET` / `AUTH_CALLBACK_BASE_URL` / `AUTH_SESSION_TTL_MS`。
- 服务端换 token 由 api 发起：服务器直连 github.com / gitee.com 受限时配 `JOB_HTTP_PROXY`（Node 全局 fetch 默认不读代理 env，api 启动时经 `proxy-bootstrap.ts` 安装全局 undici ProxyAgent）。
- 不配某个平台时，该平台登录路由返回 501、`GET /auth/providers` 只回 configured 布尔，不影响其他功能。

## 9. 安全与密钥

- `.env`、token、OAuth secret、`AUTH_STATE_SECRET`、`DEMO_IP_SALT`、LLM key 一律不入库（`.env` 已 gitignore）；新增环境变量同步更新 `.env.example`（只放键名/注释，不放值）。
- 全站 HTTPS；HttpOnly 会话 Cookie 经安全通道下发。
- 反代后必须 `TRUST_PROXY=true`，否则 IP 限流取到的是反代地址。
- 最小权限：GitHub/Gitee 凭证只申请公开只读；不 clone、不执行任何仓库代码（MVP L0/L1）。
- CI 已含 `pnpm audit --audit-level=high` 与 gitleaks 密钥扫描；密钥一旦泄露立即轮换。

## 10. 上线后验证清单（smoke）

1. `https://<域名>/` 报告站可开，中英双语正常。
2. 未登录访问他人报告：结论/技能/匹配/简历公开，证据外链/面试题/面试包显示登录墙；`interview-kit.md` 未登录 401。
3. GitHub 登录 → 回调成功 → 头部显登录身份 → 触发一次本人分析（不占 demo 配额）→「认领此画像」成功、显本人已验证徽章。
4. Gitee 同上（配置了 Gitee 应用时）；纯 Gitee 画像的登录墙指向 Gitee 登录。
5. 「试用演示」进入、三道配额闸生效；`platform=all` 融合作业按权重扣 2。
6. 跑一次单源分析（GitHub / Gitee / all）确认 worker 消费、报告生成、分享链接可访问。
7. 手动各跑一次 `jobs sync`、`demo cleanup`、`auth cleanup`，确认退出码 0、计数正常。
8. （启用 LLM 时）简历「AI 润色」返回 `polish.applied=true`；未配置时优雅回退规则版。
9. **形态 C 附加**：`https://<域名>/api/health` 返回 `{status:"ok"}`（验证同域 /api 转发）；未带 token 访问 `/api/internal/cron/process-job` 返回 401；带正确 `?token=` 返回 `{ok:true,...}`（无任务时 outcome.idle）。
10. **形态 C 附加**：浏览器走一次 `/api/auth/github/login` 真实登录，确认跳转的 redirect_uri 与 GitHub App 登记一致、回调后 Cookie 种下（验证 `API_MOUNT_PREFIX=/api` 生效）；Vercel 部署日志确认 cron 每分钟触发且未出现 FUNCTION_INVOCATION_TIMEOUT。

## 11. 仍未决 / 本手册不替你决定的事

- **形态 C 上线前待办（需真人在控制台操作）**：建 Supabase 项目并跑首次 5432 迁移；Vercel 建项目（Root Directory=`apps/report`）并填环境变量；确认 **Pro 计划**（每分钟 cron 的硬前提）；生成并替换 `CRON_SECRET`；生产 GitHub/Gitee OAuth App 回调登记为 `/api/auth/*`；Cloudflare DNS 绑定最终生产域名（占位 `app.job-agent.bayjf.com`）；真实部署后跑 §10 的 9–10 项 smoke。
- 自托管形态 A/B 的生产域名与证书、镜像 registry（形态 C 已拍板，A/B 仅备选）。
- demo 配额 / TTL / 并发的正式数值、cleanup cron 频率最终值。
- 岗位日更/HN 月更的 GitHub Actions workflow 已落地（`.github/workflows/jobs-sync.yml`），上线前需在仓库 Actions secrets 配生产 `DATABASE_URL`（5432 Session pooler 串）并在 Actions 面板手动跑一次 daily 验证。
- 真实 LLM 厂商 / 单价 / 预算。
- 真实 Gitee OAuth 应用创建与首次真实冒烟（现有 OAuth 测试全 fake/mock，不打网络）。
- #9 商业化、#14 合规、真人试用与配额压测。

---

相关文档：[API.md](API.md)（端点/错误码/可见性矩阵）、[design-auth-gating-20260919](design-auth-gating-20260919.md)、[design-gitee-oauth-20260919](design-gitee-oauth-20260919.md)、[design-demo-mode-20260915](design-demo-mode-20260915.md)、[design-storage-dual-dialect-20260911](design-storage-dual-dialect-20260911.md)、[技术选型-MVP-20260910](技术选型-MVP-20260910.md)、根 [`.env.example`](../.env.example) 与 [`docker-compose.yml`](../docker-compose.yml)。
