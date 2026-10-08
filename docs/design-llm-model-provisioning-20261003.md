# LLM 模型供给设计：内置模型（Admin UI 管理，参考 agent-world）+ BYOK（用户自由设置）

- 状态：**已拍板并落地（2026-10-03）：决策 #21 子问 0–6 全采纳助手建议；P0 里程碑全部完成（handoff item105，12 个提交未 push）**。P1 生产激活＝配 `LLM_*`/`LLM_ENC_KEY`/`ADMIN_ACCOUNT_LOGINS` env + 首个 admin 在 `/admin` 录入目录行
- 日期：2026-10-03（v3：决策 #21 全部拍板；v2 按 agent-world model-catalog 方案重构内置层管理方式）
- 关联：handoff item102/103/104；[待拍板决策清单 #21](待拍板决策清单-20260910.md)；[design-cover-letter-20261003.md](design-cover-letter-20261003.md)；[design-targeted-resume-20260915.md](design-targeted-resume-20260915.md) §10
- 参考：agent-world [design-model-catalog.md](https://github.com/bayernjf/agent-world/blob/main/docs/design-model-catalog.md)（内置目录 admin 面 + 字段归属 + 凭证 env only 不变量，2026-09-25/26 已全部落地）

## 1. 背景与动机

产品目前只有一种 LLM 供给方式：**服务端环境变量**（`LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL` / `LLM_PROVIDER`），由 `apps/api` 启动时构造 resume-polish / cover-letter 两个 provider。**没有任何用户侧配置入口**，且生产 Vercel 尚未配置 `LLM_*`（J7 未拍板）——生产上真实状态是「LLM 未启用」：简历润色走规则版回退、求职信端点返回 `LLM_NOT_CONFIGURED`。

用户 2026-10-03 拍板产品方向：

- **内置模型**：平台管理的模型供给，**通过 Admin UI 管理**（参考 agent-world 的内置模型目录方案）——不靠改代码/发版，运营在后台界面里增删、启停、切换默认模型；
- **BYOK（Bring Your Own Key）**：用户在工作台设置里**自由配置**自己的 OpenAI 兼容 base URL / API key / model，用自己的额度随意使用。

## 2. 现状核实（代码级，2026-10-03）

| 位置 | 现状 |
| --- | --- |
| `packages/llm/src/openai-compatible-client.ts` | `OpenAICompatibleClient` 为 provider-agnostic（任意 baseUrl/apiKey/model），`provider` 仅作 provenance 标识；`createResumePolishProviderFromEnv` / `createCoverLetterProviderFromEnv` **只读服务端 env**，无 key → `null`（默认关闭） |
| `apps/api/src/index.ts` | `resumePolish` / `coverLetter` 两个注入点，默认按 env 构造 |
| `apps/api/src/routes/resumes.ts` | polish 未配置走规则版回退；cover-letter 未配置 503 `LLM_NOT_CONFIGURED`（如实标注，不伪造） |
| 用户侧 | **不存在**任何模型配置表 / API / UI |
| 平台侧 | **无 admin 角色**（`accounts` 无 `role` 列，仅 `recruiterDeclaredAt` 自声明）、**无 settings 类表**、**无 audit 机制**（agent-world 的 admin 前提三件套 JobAgent 均缺，见 §4.3 适配） |

结论：内置模式 = Admin UI + 平台数据行（新面）；BYOK = 用户设置面（新面）；两者都建立在 `packages/llm` 的 provider-agnostic 客户端之上，内核无需改。

## 3. 目标形态

| 模式 | 谁维护 / 谁付费 | 管理面 | 适用场景 |
| --- | --- | --- | --- |
| 内置（平台配模型） | 平台方（运营/管理员） | **Admin UI**（增删/启停/换默认，热生效） | 默认体验；低频调用（求职信、润色） |
| BYOK（用户自带 Key） | 用户 | 工作台 Settings（**自由设置** baseUrl/key/model） | 高频/重预算用户；已有自备额度；数据偏好 |

两种模式并存、按账号回落：BYOK 优先，无 BYOK 配置则回落内置，内置未配则如实报 `LLM_NOT_CONFIGURED`（或规则版回退，按功能既有策略）。

## 4. 技术方案

### 4.1 总体：字段归属按「改一次要动什么」切（对齐 agent-world §三）

| 字段 | 归属 | 说明 |
| --- | --- | --- |
| 模型清单（id / name / enabled / isDefault / order / modalities） | **数据（Admin 面）** | 高频小改，纯数据，admin 界面维护 |
| `baseUrl` | **env**（`LLM_BASE_URL`） | 供应商端点；JobAgent 当前只接 Agnes 一个 OpenAI 兼容端点，**不进数据不进界面**（agent-world 不变量：`apiKey` 永不进数据也不进界面） |
| `apiKey` | **env only**（`LLM_API_KEY`） | 凭证，**永不进数据、不进界面、不进日志**（S5 脱敏已保证） |
| 接口方言（chat/completions 形状） | **代码，发版** | JobAgent 只承诺 OpenAI 兼容；非兼容供应商适配器＝代码改动 |

**安全不变量（本方案最重要防线，照搬 agent-world §三）**：admin 数据合并**只允许覆盖白名单字段**（`models / enabled / isDefault / order / modalities`），`baseUrl` / `apiKey` 在结构上不可被数据覆盖——不是靠界面不显示它们，而是靠合并逻辑不读它们。

### 4.2 内置模型：Admin UI + 平台数据行

**数据模型（迁移 023，与 BYOK 同批）**：新建 `llm_catalog_models` 表（一行一模型）：

```sql
CREATE TABLE llm_catalog_models (
  id           TEXT PRIMARY KEY,           -- 模型目录 id，如 agnes-2.5-flash
  provider     TEXT NOT NULL DEFAULT 'agnes',   -- provenance 标识
  model        TEXT NOT NULL,              -- 请求实际 model id
  enabled      INTEGER NOT NULL DEFAULT 1, -- 0=停用（下架）
  is_default   INTEGER NOT NULL DEFAULT 0, -- 每个模态唯一默认
  sort_order   INTEGER NOT NULL DEFAULT 0,
  modalities   TEXT NOT NULL DEFAULT '["text"]',  -- JSON 数组；当前仅消费 text
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
```

- **存储形态说明**：JobAgent 无 agent-world 的 `settings` 表，故新建独立表（不硬套"平台行"技巧）；`baseUrl` / `apiKey` 仍由 env 提供，表内**无凭证列**（结构上杜绝）。
- **读取路径**：启动时加载一次到模块级缓存，admin 写入后**显式刷新缓存**（对齐 agent-world §六的"写路径必须显式失效缓存"纪律）；代码内默认目录（当前＝`agnes-2.5-flash` 单模型）仍在 git，**删掉数据行即回到代码默认**，天然可回滚。
- **下架即报错（规则 A，对齐 agent-world §四）**：默认模型若被 admin 停用，polish / cover-letter 请求如实返回 `LLM_NOT_CONFIGURED`（不静默降级、不假成功）；报告页 UI 提示「内置模型已停用，请联系管理员」。

**Admin 面（新权限层，JobAgent 首次引入管理员）**：

- **权限**：迁移 023 同批给 `accounts` 加 `is_admin INTEGER NOT NULL DEFAULT 0`（对齐 agent-world `users.role='admin'` 的语义，但 JobAgent 用布尔列更贴合现有 schema 风格）；API 鉴权＝`resolvePrincipal` 后查 `is_admin`，非 admin 一律 403。
- **首个 admin 授予方式（待拍板，决策 #21 子问 6）**：方案 A＝env 白名单（`ADMIN_ACCOUNT_LOGINS=bayernjf`，启动/登录时若匹配则自动置 `is_admin=1`）——零手工 SQL，推荐；方案 B＝手动 SQL `UPDATE accounts SET is_admin=1 WHERE login='...'`——可控但需用户操作。
- **端点（仅 admin）**：
  - `GET /admin/llm-catalog`：当前目录（模型清单 + 启用/默认态）
  - `PUT /admin/llm-catalog`：整体替换目录（白名单字段合并，结构上不可覆盖 baseUrl/apiKey）
  - `POST /admin/llm-catalog/refresh`：显式刷新运行时缓存（或写入即刷新）
- **UI**：`apps/report` 的 `/[locale]/admin` 面板（仅 `is_admin` 可见）：模型列表（启用开关 / 设默认 / 排序 / 新增 / 删除）、变更即写即生效提示；i18n 双语 key。样式沿用 design token。**入口（2026-10-08 最终态，对齐 agent-world）＝账号菜单「模型管理」链接，仅 `canManageLlmCatalog` 能力位为真时显示**（agent-world 同款：UserMenu 按 role 显示 Admin 项）；地址栏直达 `/[locale]/admin` 同样可用；页面 `robots=noindex,nofollow`，非 admin 无论从菜单还是地址栏都只见登录闸/403。
- **审计（简化版，完整 audit 缓做）**：目录每次写入记结构化 server 日志（`[admin-catalog] action=upsert/delete actor=<login> models=<ids>`，**不记凭证、不记价格**）；完整审计表机制（对齐 agent-world design-audit-log）列为 deferred。

### 4.3 BYOK：用户自由设置（工作台 Settings）

用户语义＝**随便设置使用**：在工作台设置面板填任意 OpenAI 兼容 `baseUrl` / `model` / `apiKey`，保存后 polish / cover-letter 即走用户自己的配置；不设上限、不与内置互相干扰。

**数据模型（迁移 023 同批）**：新建 `user_llm_configs` 表：

```sql
CREATE TABLE user_llm_configs (
  account_id        TEXT PRIMARY KEY,          -- 与 accounts 主键一致
  provider          TEXT NOT NULL DEFAULT 'custom',
  base_url          TEXT NOT NULL,             -- https 校验
  model             TEXT NOT NULL,
  api_key_encrypted TEXT NOT NULL,             -- AES-256-GCM 密文
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
```

- **密钥加密（决策 #21 子问 1，已倾向服务端加密列）**：AES-256-GCM，主密钥 `LLM_ENC_KEY`（env，与 `LLM_API_KEY` 同等保密）；解密仅在内存、调用后即弃；任何日志/错误体不回显 key（复用 S5 `apiKey → [REDACTED]`）；API 回显只给掩码 `sk-****<末4位>`。**否决仅浏览器本地**：LLM 调用发生在 api 服务端，本地 key 必须随请求上传＝明文过网络，且多端不一致。
- **API（仅登录 user）**：`GET /account/llm-config`（含 keyMasked）/ `PUT /account/llm-config`（未传 key 不覆盖既有 key）/ `DELETE /account/llm-config` / `POST /account/llm-config/validate`（最小 `max_tokens=1` 验证）。
- **请求路由（api 层）**：polish / cover-letter 每次调用前，取登录账号 llm-config → 有则 BYOK provider（`provider:'custom'`，provenance 标注用户自配）；无则回落内置目录；内置也未配 → 按功能既有策略（polish 规则版 / cover-letter 503）。
- **安全**：配置按 `account_id` 隔离（他人 404/403）；`base_url` 必须 `https://`、字段长度上限；出站**超时 + 不跟随重定向 + 账号级限流**（BYOK 任意 base_url 是出站代理面，风险登记见 §7）。
- **UI**：工作台「模型设置」面板：模式切换（内置 / 自带 Key）、BYOK 表单、保存即 validate、掩码展示、清除；调用入口（ResumeBuilder / 求职信区）在 BYOK 生效时显示「你的模型」徽标。

### 4.4 与 agent-world 的差异适配（JobAgent 缺失项）

| agent-world 前提 | JobAgent 现状 | 适配 |
| --- | --- | --- |
| `users.role='admin'` + `/me` 露 `canManageXxx` | `accounts` 无角色列 | 迁移 023 加 `is_admin` 列 + admin 端点鉴权；`/me` 露 `canManageLlmCatalog`（对齐形状） |
| `settings` 表平台行（复用加密与备份链路） | 无 settings 表 | 新建 `llm_catalog_models` 独立表（一行一模型）；凭证不入表 |
| audit-log 机制 | 无 audit 表 | 简化：目录写入记结构化 server 日志；完整审计表缓做（deferred） |
| 平台数据行启动加载 + 写后显式刷新 | 无对应 | 同方案：启动加载一次 + admin 写入后显式刷新模块级缓存 |

## 5. 决策点（待拍板，已登记决策 #21）

| 子问 | 选项 | 助手建议 | 状态 |
| --- | --- | --- | --- |
| 0. 内置管理方式 | Admin UI（参考 agent-world）/ 继续改 env 发版 | **Admin UI** | ✅ **已拍板 2026-10-03** |
| 0'. BYOK 开放度 | 用户自由设置任意 OpenAI 兼容端点 / 限定白名单厂商 | **用户自由设置** | ✅ **已拍板 2026-10-03** |
| 1. BYOK 密钥存储 | A 服务端加密列（`LLM_ENC_KEY`）/ B 仅浏览器本地 | **A**（LLM 调用在服务端，本地 key 明文过网络） | ✅ **已拍板 2026-10-03（A）** |
| 2. 内置凭证形态 | A `apiKey`/`baseUrl` 仍 env only（agent-world 不变量）/ B 也进 admin 数据面 | **A**（凭证永不进数据不进界面） | ✅ **已拍板 2026-10-03（A）** |
| 3. 内置成本与配额 | A 平台承担、内置免费（账号级限流兜底）/ B 内置仅 demo 预置 | **A** | ✅ **已拍板 2026-10-03（A）** |
| 4. BYOK 与平台配额 | A BYOK 不计平台配额（仅账号级限流）/ B 同样计入 | **A** | ✅ **已拍板 2026-10-03（A）** |
| 5. 首个 admin 授予 | A env 白名单自动置位（`ADMIN_ACCOUNT_LOGINS`）/ B 手动 SQL | **A**（零手工操作） | ✅ **已拍板 2026-10-03（A）** |
| 6. 一账号一条 vs 按用途多条 | A 一条文本模型配置 / B polish 与 cover-letter 各一 | **A**（MVP 简化） | ✅ **已拍板 2026-10-03（A）** |

> **【你的决定】（2026-10-03 全部拍板，0–6 全采纳助手建议）**：内置＝Admin UI 管理（admin 管目录、凭证 env only）；BYOK＝用户自由设置（一账号一条、服务端加密列、不计平台配额、账号级限流）；内置免费平台承担；首个 admin 经 `ADMIN_ACCOUNT_LOGINS` env 白名单自动置位。

## 6. 里程碑拆分

- **P0 内置层基建（✅ 已落地 2026-10-03，handoff item105）**：迁移 023–025（`llm_catalog_models` + `accounts.is_admin` + `user_llm_configs`）+ `packages/llm` 目录合并纯函数（白名单 pick）+ 启动加载/显式刷新缓存 + admin 端点（GET/PUT/refresh）+ admin 面板 UI（report `/admin` + AccountMenu「模型管理」入口，能力位控制显示，对齐 agent-world）+ BYOK 4 端点（AES-256-GCM 加密列）+ 工作台模型设置面板 + 请求路由（BYOK 优先 → 内置回落）+ i18n 48 key + 测试（含凭证不入表、越权 403、白名单不可覆盖 baseUrl/apiKey、validate、回落链、停用即报错；storage 205 / llm 46 / api 249 / report 155 全绿）。
- **P1 生产激活（J7 变体）**：生产 Vercel 配 `LLM_*`（`LLM_BASE_URL` / `LLM_API_KEY` = Agnes）+ `LLM_ENC_KEY` + `ADMIN_ACCOUNT_LOGINS`；首个 admin 登录后在 Admin UI 录入 `agnes-2.5-flash` 目录行。**注意**：P1 仍要配 env——按 agent-world 不变量，**凭证永远在 env**，admin UI 管理的是目录不是凭证。
- **P2 体验增强（缓做）**：`GET /models` 探测、用量展示、完整审计表、内置/BYOK 混用策略。

## 7. 风险与边界

| 风险 | 缓解 |
| --- | --- |
| BYOK 任意 base_url = 出站代理面（SSRF/滥用） | 仅 `https://`、超时、不跟随重定向、账号级限流、错误体不回显上游响应详情 |
| 内置凭证泄露 | **凭证只在 env**（agent-world 不变量）+ S5 日志脱敏 + admin 面无凭证列 |
| admin 越权 | `is_admin` 鉴权 + 非 admin 403 + `/me` 只露布尔能力位，不引新 RBAC 概念 |
| 内置目录被误改 | 白名单合并（结构上不可覆盖凭证/方言）+ 写入记结构化日志 + 删数据行即回代码默认 |
| 非 OpenAI 兼容厂商 | 只承诺 `chat/completions` 兼容；不兼容返回明确提示，适配器＝代码发版 |

**非目标**：多模型路由/负载均衡、RAG、图像/视频模型接入（当前代码只消费文本模型；`agnes-image-2.5-flash` / `agnes-video-2.5-flash` 仍为未消费备用，不纳入本设计）。

## 8. 决策记录

- 2026-10-03（v1）：用户提出「内置模型（Agnes）+ BYOK」双轨；设计文档立项，决策 #21 待拍板（handoff item102）。
- 2026-10-03（v2）：**用户拍板子问 0/0'**——内置模型＝**Admin UI 管理**（参考 agent-world [design-model-catalog](https://github.com/bayernjf/agent-world/blob/main/docs/design-model-catalog.md)，管理目录而非凭证）；BYOK＝**用户自由设置**。设计按 agent-world 方案重构：字段归属按「改一次动什么」切、凭证 env only 不变量、下架即报错、启动加载+写后显式刷新、admin 权限与简化审计；并登记 JobAgent 三项差异适配（无 role/无 settings 表/无 audit）。handoff item103。
- 2026-10-03（v3）：**决策 #21 子问 1–6 全部拍板（全采纳助手建议）**——BYOK 密钥＝服务端 AES-256-GCM 加密列（`LLM_ENC_KEY`）；内置凭证＝env only；内置免费平台承担；BYOK 不计平台配额（账号级限流）；首个 admin＝`ADMIN_ACCOUNT_LOGINS` env 白名单自动置位；BYOK＝一账号一条。**设计定稿，P0 待开工**。handoff item104。
- 2026-10-08（v4）：**用户先要求入口隐藏、随后同日改回（最终态＝保留入口）**——上午要求「不在产品 UI 显示、仅地址栏 `/admin` 访问」，已临时移除 AccountMenu 链接与 `account.admin` key；用户随后改主意：「改回来，如果 agent-world 有的话那你也加一下」。核实 agent-world 的 model-catalog 入口＝**UserMenu 按 role（owner/admin）显示 Admin 项**，job-agent 原实现（`canManageLlmCatalog` 能力位 + AccountMenu 链接）与之同构 → **恢复入口，最终态＝能力位控制显示 + 地址栏直达并存**；`robots=noindex` 与 is_admin 403 不变。已落地，原子提交（未 push）。
