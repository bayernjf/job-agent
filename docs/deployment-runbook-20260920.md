# JobAgent 部署 / 上线 Runbook

> 状态：**现行（运维操作手册）**，2026-09-20。本文档只讲"怎么部署、上线前要准备什么、上线后怎么验"，**不替产品负责人做未拍板决策**——部署形态（A/B）、生产域名、demo 配额数值、LLM 厂商等仍以 [待拍板决策清单](待拍板决策清单-20260910.md) 与 [handoff](../handoff.md)「已知限制」为准，文中显式标注。
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
| 1 | **部署形态 A / B** | A 同域反向代理（推荐）/ B 跨子域，决定 Cookie 作用域与 CORS，见 §4 | ⏳ 未拍板 |
| 2 | **生产域名 + HTTPS 证书** | OAuth 回调、`AUTH_CALLBACK_BASE_URL`、CORS 白名单都依赖它 | ⏳ 未拍板 |
| 3 | **Postgres 实例** | 生产建议 Postgres；准备连接串、账号、备份策略 | 代码就绪，实例未建 |
| 4 | **GitHub OAuth App（生产）** | 回调 `https://<域名>/auth/github/callback`，scope `user:email` | 仅有本地 App（id 3868123，仅 localhost） |
| 5 | **Gitee OAuth 应用（生产）** | Gitee→设置→第三方应用，回调 `https://<域名>/auth/gitee/callback`，scope `user_info` | ❌ 连本地都还没建真实应用 |
| 6 | **`AUTH_STATE_SECRET`** | 生产多实例必须固定一个随机 HMAC 密钥；留空则进程内随机、重启使进行中登录失效 | 未生成 |
| 7 | **`GITHUB_TOKEN` / `GITEE_TOKEN`** | worker 必需 GitHub 凭证（生产建议 GitHub App）；Gitee 匿名可读公开数据、token 仅提额 | 本地 `.env`，不入库 |
| 8 | **`DEMO_IP_SALT`** | 生产固定随机盐，否则重启后 IP 限流窗口失效 | 未生成 |
| 9 | **demo 配额 / TTL 数值** | `.env.example` 是可配建议默认值，正式数值待拍板（见设计 §16） | ⏳ 未拍板 |
| 10 | **LLM（可选）** | 不填则简历走纯规则版；启用需 OpenAI 兼容端点 + `LLM_API_KEY`/`LLM_MODEL`，费用与厂商自定 | 默认关闭 |
| 11 | **镜像 registry** | 镜像目前未推任何 registry；要么服务器本地 build，要么先推 registry | 未做 |
| 12 | **合规（#14）** | 隐私政策 / 数据处理 / 海内外合规线，公开上线前需过 | 延后 |

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
| `PUBLIC_API_BASE` | **构建期**变量 | 见 §4，极易踩坑：它在 `docker build` 时固化，不是运行时 |

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

> 两种形态都要求 HTTPS（登录会话是 HttpOnly Cookie）。形态选择未拍板前，不要把任一种的配置当成既定事实。

## 5. 数据库

- 生产用 Postgres：`DB_DRIVER=postgres` + `DATABASE_URL`；compose 用 `--profile with-pg` 起本地库，托管库则不需要 `db` 服务。
- 迁移随服务启动自动应用，无需单独迁移步骤；若希望显式控制，可在发布流程里先用 cli 跑一次（cli 非只读打开同样 autoMigrate）。
- 建议：托管 PG 开自动备份；定期备份 `profiles/evidence/analysis_jobs/accounts/auth_sessions/job_postings/waitlist` 等表。
- SQLite 仅适合本地 / 单机 demo；多实例或对外服务用 Postgres。

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

## 8. OAuth 生产配置要点

- GitHub OAuth App：回调 `https://<域名>/auth/github/callback`，scope `user:email`。
- Gitee 第三方应用：回调 `https://<域名>/auth/gitee/callback`，scope 固定 `user_info`（仅公开身份 id/login/name/头像，邮箱可能为空）。协议三处与 GitHub 的差异见 [design-gitee-oauth-20260919](design-gitee-oauth-20260919.md) §2。
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

## 11. 仍未决 / 本手册不替你决定的事

- 部署形态 A/B、生产域名与证书、镜像 registry。
- **report SSR 服务端取数的 api 基址在反代后的配置方式**（§4 形态 A 的浏览器/SSR 基址冲突）——需 staging 实测，必要时拆成"公开基址 / 内部基址"两个变量（小代码改动，验证后再做）。
- demo 配额 / TTL / 并发的正式数值、cleanup cron 频率最终值。
- 真实 LLM 厂商 / 单价 / 预算。
- 真实 Gitee OAuth 应用创建与首次真实冒烟（现有 OAuth 测试全 fake/mock，不打网络）。
- #9 商业化、#14 合规、真人试用与配额压测。

---

相关文档：[API.md](API.md)（端点/错误码/可见性矩阵）、[design-auth-gating-20260919](design-auth-gating-20260919.md)、[design-gitee-oauth-20260919](design-gitee-oauth-20260919.md)、[design-demo-mode-20260915](design-demo-mode-20260915.md)、[design-storage-dual-dialect-20260911](design-storage-dual-dialect-20260911.md)、[技术选型-MVP-20260910](技术选型-MVP-20260910.md)、根 [`.env.example`](../.env.example) 与 [`docker-compose.yml`](../docker-compose.yml)。
