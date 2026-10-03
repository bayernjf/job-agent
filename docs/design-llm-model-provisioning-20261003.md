# LLM 模型供给设计：内置模型（Agnes）+ BYOK（自带 Key）

- 状态：**待拍板（决策 #21）**；设计定稿，代码未动
- 日期：2026-10-03
- 关联：handoff item102；[待拍板决策清单 #21](待拍板决策清单-20260910.md)；[design-cover-letter-20261003.md](design-cover-letter-20261003.md)；[design-targeted-resume-20260915.md](design-targeted-resume-20260915.md) §10

## 1. 背景与动机

产品目前只有一种 LLM 供给方式：**服务端环境变量**（`LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL` / `LLM_PROVIDER`），由 `apps/api` 启动时构造 resume-polish / cover-letter 两个 provider。**没有任何用户侧配置模型的入口**，且生产 Vercel 尚未配置 `LLM_*`（J7 未拍板）——生产上真实状态是「LLM 未启用」：简历润色走规则版回退、求职信端点返回 `LLM_NOT_CONFIGURED`。

用户 2026-10-03 提出产品方向：模型供给分两种模式——

- **内置模型**：平台配好（Agnes `agnes-2.5-flash` 等），用户零配置、开箱即用；
- **BYOK（Bring Your Own Key）**：用户在工作台设置里填自己的 OpenAI 兼容 base URL / API key / model，用自己的额度调用。

这是 AI 工具的主流供给形态（平台内置按量 / 用户自备额度省钱或数据可控 / 双轨并存），也是本产品从「分析工具」走向「求职 Copilot」的体验前提——求职信与润色是低频低成本调用，内置免费即可覆盖，BYOK 服务高频/重预算用户。

## 2. 现状核实（代码级，2026-10-03）

| 位置 | 现状 |
| --- | --- |
| `packages/llm/src/openai-compatible-client.ts` | `OpenAICompatibleClient` 为 provider-agnostic（任意 baseUrl/apiKey/model），`provider` 仅作 provenance 标识；`createResumePolishProviderFromEnv` / `createCoverLetterProviderFromEnv` **只读服务端 env**，无 key → `null`（默认关闭） |
| `apps/api/src/index.ts` | `resumePolish` / `coverLetter` 两个注入点，默认按 env 构造 |
| `apps/api/src/routes/resumes.ts` | polish 未配置走规则版回退；cover-letter 未配置 503 `LLM_NOT_CONFIGURED`（如实标注，不伪造） |
| 用户侧 | **不存在**任何模型配置表 / API / UI |

结论：**内置模式 = 现有代码 + 生产 env（J7）**；**BYOK = 全新功能面**（数据模型、API、安全、UI）。

## 3. 目标形态

| 模式 | 谁付费 | 用户配置 | 适用场景 |
| --- | --- | --- | --- |
| 内置（平台配 Agnes） | 平台 | 零配置 | 默认体验；低频调用（求职信、润色） |
| BYOK（自带 Key） | 用户 | 设置面板填 baseUrl / key / model | 高频/重预算用户；已有自备额度；数据偏好 |

两种模式并存、按账号回落：BYOK 优先，无 BYOK 配置则回落内置，内置未配则如实报 `LLM_NOT_CONFIGURED`（或规则版回退，按功能既有策略）。

## 4. 技术方案

### 4.1 内置模型（P0，零代码）

- **J7 拍板**：生产 Vercel 配 `LLM_BASE_URL=https://apihub.agnes-ai.com/v1`、`LLM_API_KEY=<agnes key>`、`LLM_MODEL=agnes-2.5-flash`、`LLM_PROVIDER=agnes`（本地 `.env` 已配同款，可先本地联调）。
- 现有代码零改动；provenance 已带 `provider/model/promptVersion`，UI 可展示「Powered by Agnes」。

### 4.2 BYOK（P1，新功能面）

**数据模型（迁移草案 023）**：新表 `user_llm_configs`

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

每账号一条文本模型配置（MVP 简化；按用途拆分的选项见决策 #21 子问 4）。

**密钥加密（决策 #21 子问 1）**：服务端 AES-256-GCM 加密列，主密钥 `LLM_ENC_KEY`（env，须与 `LLM_API_KEY` 同等保密）。解密仅在内存、调用后即弃；**任何日志/错误体不回显 key**（复用 S5 脱敏：`apiKey → [REDACTED]`）；API 回显只给掩码 `sk-****<末4位>`。
方案 B（仅浏览器本地）被否决：LLM 调用发生在 **api 服务端**，本地 key 要随请求上传才能用——等于明文 key 过网络，反而扩大泄露面，且报告页 SSR/工作台多端不一致。

**API（草案，仅登录 user）**：

| 端点 | 行为 |
| --- | --- |
| `GET /account/llm-config` | 返回 `{ provider, baseUrl, model, keyMasked, active }`，永不回显完整 key |
| `PUT /account/llm-config` | 写入/更新（key 加密落库；**未传 key 时不覆盖既有 key**，便于只改 model） |
| `DELETE /account/llm-config` | 清除配置，回落内置/503 |
| `POST /account/llm-config/validate` | 用提交的 key 发一次最小 `chat/completions`（`max_tokens=1`）验证，返回 200 / 401 |

**请求路由（api 层）**：resume-polish / cover-letter 每次调用前，取登录账号的 llm-config → 有则构造 BYOK provider（复用 `OpenAICompatibleClient`，provider 标识 `user-configured`）；无则回落内置；内置也未配 → 按功能既有策略（polish 规则版 / cover-letter 503）。BYOK 产物 provenance 标注用户自配，UI 提示「由你的模型生成」。

**安全与滥用控制**：

- 配置按 `account_id` 隔离，他人账号返回 404/403；
- `base_url` 必须 `https://`、model 非空、字段长度上限；出站请求加**超时 + 不跟随重定向 + 账号级限流**（BYOK 任意 base_url 是出站代理面，风险登记见 §7）；
- key 生命周期：写入即加密、删除即不可恢复、不写入任何日志与错误体（S5 已覆盖）。

**UI（报告页设置面板）**：模式切换（内置 / 自带 Key）；BYOK 表单（provider 预设或自定义 baseUrl、model、key）；保存即触发 validate；掩码展示；清除按钮；双语 i18n key。调用入口（ResumeBuilder / 求职信区）在 BYOK 生效时显示「你的模型」徽标。

## 5. 决策点（待拍板，已登记决策 #21）

| 子问 | 选项 | 助手建议 | 不定的后果 |
| --- | --- | --- | --- |
| 1. BYOK 密钥存储 | A 服务端加密列（`LLM_ENC_KEY`）/ B 仅浏览器本地 | **A**（LLM 调用在服务端，本地 key 必须随请求上传＝明文过网络） | B 扩大泄露面、多端不一致 |
| 2. 内置模型成本 | A 平台承担、内置免费 / B 内置仅 demo 预置 | **A**（求职信/润色低频低成本；配账号级限流兜底） | 内置滥用致成本无上限（需限流） |
| 3. BYOK 与平台配额 | A BYOK 不计平台配额（只账号级限流）/ B 同样计入 | **A**（自备 key 用户不该吃平台配额） | B 误伤 BYOK 用户 |
| 4. 一账号一条 vs 按用途多条 | A 一条文本模型配置 / B resume-polish 与 cover-letter 各一 | **A**（MVP 简化；同文本模型够用） | B 灵活但设置复杂 |
| 5. 优先级 | A 先 J7 内置激活，BYOK 后置 / B 并行 | **A**（J7 零代码、立即解锁求职信；BYOK 建立在「内置可用」之上） | 不做 J7 则 BYOK 落地后内置仍是空壳 |

## 6. 里程碑拆分

- **P0 内置激活（J7）**：生产 Vercel 配 `LLM_*`（Agnes）。零代码；交付＝生产求职信/润色可用。唯一动作＝用户控制台配 env。
- **P1 BYOK 最小闭环**：迁移 023 `user_llm_configs` + 加密工具（`packages/llm` 或 `apps/api` 内）+ 4 个设置端点 + api 请求路由（BYOK 优先 → 内置回落）+ 报告页设置面板 + i18n + 测试（含密钥不回显、越权、validate、回落链）。LLM 调用全程复用现有 provider-agnostic 客户端。
- **P2 体验增强（缓做）**：`GET /models` 模型列表选择（Agnes 支持时）、用量展示、内置/BYOK 混用策略、模型说明页。

## 7. 风险与边界

| 风险 | 缓解 |
| --- | --- |
| BYOK 任意 base_url = 出站代理面（SSRF/滥用） | 仅 `https://`、超时、不跟随重定向、账号级限流、错误体不回显上游响应详情 |
| key 泄露 | 加密列 + `LLM_ENC_KEY` env + S5 日志脱敏 + 掩码回显 + 永不入库明文 |
| 非 OpenAI 兼容厂商 | 只承诺 `chat/completions` 兼容；不兼容返回明确提示，不做适配器 |
| 内置模型成本失控 | 决策 #21 子问 2/3 定限流口径后落实（P1 实现账号级限流） |

**非目标**：多模型路由/负载均衡、RAG、图像/视频模型接入（当前代码只消费文本模型；`agnes-image-2.5-flash` / `agnes-video-2.5-flash` 仍为未消费备用，不纳入本设计）。

## 8. 决策记录

- 2026-10-03：用户提出「内置模型（Agnes）+ BYOK」双轨供给；本设计文档立项，决策 #21 待拍板（handoff item102）。
