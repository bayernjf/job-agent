# Vercel 模型中心变量与 Supabase 口令轮换验证（2026-11-06）

> 本清单只写「取哪里、怎么加、怎么验」，**不含任何密钥明文**。执行时不要 `cat` 整个
> `.env`，不要把 token / 连接串贴进聊天、Issue、提交、截图或日志。所有 `<>` 占位符
> 在你自己的私密终端里替换。

## 0. 适用范围与三个前置

目标：让 Vercel 上的 job-agent API 用 model-hub **项目 token** 拉取模型目录，并在
Supabase 口令轮换后确认数据库读写链路正常。

动手前先确认：

1. **构建能解析 model-kit**：Vercel 构建必须能安装 `@model-hub/model-kit`（monorepo
   含 `model-hub/`，或改成版本化依赖）。这是 handoff §6 记录的当前阻塞项；不解决时加
   变量也只会部署失败。
2. **hub 基址对 Vercel 可达**：model-hub 默认只绑 `127.0.0.1:8791`，经 Caddy 仅内网 /
   Tailscale 暴露（见 `model-hub/DEPLOYMENT.md` 拓扑与 Caddy 片段）。Vercel 函数访问
   不到内网地址；没有「Vercel 出站可达」的 HTTPS 基址（公网 TLS 或 Tailscale Funnel +
   ACL）时，**先不要加这两条变量**，否则只会得到 `fetch failed`。
3. **hub 项目就绪**：管理台里 `job-agent` 项目已启用，token 列表的 hint 末四位是
   `8798`。

## 1. 加 `MODEL_HUB_URL`

| 项 | 内容 |
| --- | --- |
| 含义 | hub 根基址（只含 scheme + host，**不带** `/pub/v1`、不带尾斜杠；model-kit 自己拼路径） |
| 生产值来源 | model-hub 部署负责人提供的 Caddy 反代 origin，形如 `https://<HUB_DOMAIN>`。权威说明在 `model-hub/DEPLOYMENT.md` 的拓扑 / Caddy 片段；本仓 `.env.example` 该变量为空 |
| 本地值 | `job-agent/.env` 里的 `http://127.0.0.1:8791` 仅本机可用，**不能**填进 Vercel |
| 加在哪 | Vercel Dashboard → 选中 job-agent 项目 → **Settings → Environment Variables → Add New** |
| Key / Value | `MODEL_HUB_URL` / `https://<HUB_DOMAIN>` |
| 范围 | 勾 **Production**（需要 Preview 也用同一 hub 时再勾 Preview；不要勾 Development） |
| 保存后 | 点 **Save**，然后必须按 §3 redeploy；环境变量不会热更新到已运行实例 |

自查：在能访问 hub 的机器上 `curl -fsS "$MODEL_HUB_URL/healthz"` 应返回 2xx。Vercel 侧
是否可达，只能靠 §4 的部署日志确认。

## 2. 加 `MODEL_HUB_TOKEN`

| 项 | 内容 |
| --- | --- |
| 含义 | model-hub **项目 token**（不是 admin key）。admin token 只能调 `/api/admin/*`，调不了项目面 `/pub/v1/*` |
| 获取路径 | hub 管理台 `/admin/projects` → 找到项目 `job-agent` → 点「签发 Token」→ 弹窗显示一次性明文；列表 hint 末四位核对为 `8798` |
| 本地已有副本 | `job-agent/.env` 的 `MODEL_HUB_TOKEN`（已被 gitignore）。不要整文件 `cat`，只看这一行 |
| 签发行为 | 会新增一个启用中的 token，**旧的仍保持启用**，可无停机切换；确认新 token 生效后再回管理台把旧 token 停用 |
| 加在哪 | 同 §1 的 Environment Variables 入口 |
| Key / Value | `MODEL_HUB_TOKEN` / 粘贴明文 |
| 范围 / 安全 | **Production**；勾选 **Sensitive**；`Save` |
| 建议同时加 | `MODEL_HUB_CACHE_PATH=/tmp/model-hub-cache.json`。Vercel 文件系统除 `/tmp` 外只读，默认 `./data/model-hub-cache.json` 可能写入失败并触发初始化告警 |

**禁止**把 token 写进文档、提交、Issue、日志或截图；需要复核时只看末四位 `8798`。

## 3. 加完如何 redeploy

环境变量只对**新构建**生效，必须重新部署：

1. Vercel → job-agent 项目 → **Deployments** → 选最新 Production deployment；
2. 右侧 **⋯ → Redeploy** → 确认；
3. 等状态变成 **Ready**（不要 cancel，也不要在此期间再改变量）；
4. 不需要 push 代码；redeploy 使用当前 Production 分支与最新环境变量。

CLI 等价路径（需账号本人操作，agent 不代跑、不写入 Vercel）：
`vercel env add MODEL_HUB_URL production`、`vercel env add MODEL_HUB_TOKEN production`，
然后 `vercel redeploy <deployment-url>`。

## 4. redeploy 后的验证

### 4.1 冷启动日志（先看这条）

Vercel → 项目 → **Logs**（Functions）→ 选最新 Production 时间窗，过滤 `[hub]`：

- 成功：`[hub] catalog synced: revision=<n>, <n> text model(s)`。
  `revision` 应与 hub 管理台当前 revision 一致；`text model(s)` ≥ 1。
- **没有这一行**：这个 deployment 没读到变量。检查是否只加到了 Preview，或加完没
  redeploy。
- `[hub] initial catalog sync failed: ...`：URL 不可达、token 401、证书或网络问题。
- `[hub] failed to initialize catalog sync: ...`：hub 客户端创建失败（常见是缓存路径
  不可写，见 §2 的 `/tmp` 建议）。

### 4.2 管理台同步（可选，需管理员登录）

`POST https://<生产域名>/api/admin/llm-catalog/sync`（带管理员 Cookie）：

| 结果 | 含义 |
| --- | --- |
| 200 + `sync: { revision, pulled, synced }` | URL / token 已生效，目录已替换 |
| 409 `model-hub is not configured` | 变量没被读到（多半没 redeploy 或只加到 Preview） |
| 502 `hub sync failed` + `detail` | hub 侧拒绝或网络失败；按 `detail` 排查 URL / token / 出站 |

### 4.3 打一次真实 chat（最终判据）

`POST https://<生产域名>/api/resumes/build`，带**登录用户 Cookie**，body：

```json
{
  "profileId": "<本人画像 id>",
  "posting": {
    "title": "模型连通性验证",
    "company": "internal",
    "description": "仅用于验证 LLM 链路，岗位描述任意一段文字即可。"
  },
  "polish": true,
  "locale": "zh-CN"
}
```

看响应字段：

- `polish.requested = true` 且 `polish.applied = true`；
- `draft.provenance.polish.provider` / `model` / `promptVersion` / `appliedAt` 有值 →
  确实走了 hub 提供的文本模型；
- `polish.applied = false`：`reason=not_configured`＝没有解析到模型（URL / token /
  目录）；`reason=provider_error`＝hub 可达但模型调用失败（看 hub 侧日志与额度）；
  其它 reason 按枚举值定位。

> 这是一次**真实付费调用**（会向 hub 回传 `project=job-agent`、`feature=resume_polish`
> 的用量），不要循环压测。

### 4.4 用量回传（可选）

hub 管理台用量页确认最近一条 `job-agent` 记录与 §4.3 的时间吻合，说明 chat 与 usage
回传两条链路都通。

## 5. Supabase 口令轮换后的验证清单

### 5.1 轮换与下发

1. Supabase Dashboard → 项目 → **Project Settings → Database → Reset database password**，
   新密码只显示一次，先复制到私密位置。
2. Vercel → job-agent 项目 → Settings → Environment Variables → 更新 `DATABASE_URL`
   （**Production**）：保持 6543 事务池化串形态
   `?pgbouncer=true&sslmode=no-verify`（格式见 `.env.example` 末尾注释），只替换密码段。
3. 本地迁移 / 备份用的 5432 session 串单独更新（`DATABASE_TEST_URL` 仅本地 / CI 用，
   不要放进 Vercel）。
4. 按 §3 redeploy；保持 `DB_AUTO_MIGRATE=false`，不要在 serverless 冷启动跑迁移。

### 5.2 旧串被拒（证明轮换真的生效）

在私密终端、用临时变量持有带旧密码的串（不要 `echo`、不要写进命令历史文件）：

```bash
psql "$OLD_DATABASE_URL" -c 'select 1'
```

预期非 0 且报错含 `FATAL: password authentication failed`（GoTrue/pooler 也可能报
`Tenant or user not found`）。若旧串仍能连，说明密码未重置或替换未生效。

### 5.3 `/api/health` 200

```bash
curl -fsS "https://<生产域名>/api/health?deep=1"
```

预期 200 + `{"status":"ok","service":"jobagent-api","db":"ok","dbLatencyMs":<n>,...}`。
503 且 `db:"unreachable"` / `schemaDrift` 非空＝新串或迁移状态有问题；503 且带
`watchdog.status="error"`＝cron 消费方告警（与口令无关，但同一窗口内一并处理）。

### 5.4 写链路验证

job-agent **没有联系表单**；用匿名公开写接口验证数据库可写（安全、可重复、不污染业务表）：

```bash
curl -fsS -X POST "https://<生产域名>/api/demo/sessions" \
  -H 'content-type: application/json' -d '{}'
```

预期 201 + `{"kind":"demo","sessionId":...,"expiresAt":...,"analyzeQuota":...}`。
若返回 5xx 且日志出现 `password authentication failed` / `ECONNREFUSED`，说明新串未
生效或 `DATABASE_URL` 仍是旧值。

> 如果这次轮换的是 **bayjf 的 Supabase**（联系表单所在项目），在 bayjf 仓按同样三步
> 单独验收：旧串被拒 → `GET https://bayjf.com/api/health` 200 → `POST
> https://bayjf.com/api/contact` 提交一条带 `ROTATION-CHECK` 标记的测试留言，随后在
> 该项目 `contact_messages` 表确认 1 行并删除测试行。两个站点不要混用连接串。

### 5.5 收尾

- 确认所有持有旧口令的地方都已替换：Vercel Production/Preview、GitHub Secrets、本地
  `.env`、备份脚本的运行环境。
- 记录**轮换时间、新 token 末四位（8798）、验证结果**；任何完整密钥都不落盘。
- 若 §5.2–§5.4 任一不通过，按失败项回退到上一条可用 `DATABASE_URL` 并 redeploy，再排查。
