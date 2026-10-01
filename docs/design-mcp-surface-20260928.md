# MCP 接入面设计（v0，2026-09-28 提案 / 2026-10-01 落地）

- 状态：**已落地（2026-10-01，决策 #19 三个子问按建议决策）**。实现见 `apps/mcp`：stdio server + 四个只读工具（`search_jobs` 公开；`get_profile`/`lookup_profile_by_subject`/`match_profile_to_job` 需 `MCP_API_KEY`），fail-closed、固定窗限流、模块图守护（不直读 storage）、零迁移零内核改动，契约/负向可见性/限流测试共 24 个。§7 三问决策＝① 引 `@modelcontextprotocol/sdk`（仅装 `apps/mcp`，stdio only）② 未配 key fail-closed、生产缺 key 启动即失败 ③ v0 不给证据外链（只留内部 evidenceRefs）。
- 定位：回答"别的系统（agent / IDE / CLI 工具）要通过 MCP 用 JobAgent，接口长什么样、能看见什么、谁付配额"。
- 关联：HTTP 契约 [API.md](API.md)、可见性矩阵 [design-auth-gating-20260919.md](design-auth-gating-20260919.md)、画像契约 `packages/shared`、C 端方向 [design-c-side-first-20260925.md](design-c-side-first-20260925.md)。

## 1. 现状（逐条实查，非推测）

| 事实 | 证据 |
| --- | --- |
| 全仓**没有** MCP 服务面，也没有任何 MCP SDK 依赖 | `package.json` 全量 grep `mcp` 零命中；代码里命中 `modelcontextprotocol` 的只有 `packages/analyzer-core/src/skills-catalog.ts` 与 `skills.test.ts`——那是**把 MCP 当技能词条检测**，不是实现 |
| 对外集成契约只有 HTTP 一份，30 条路由 | `apps/api/src/index.ts`（`/analyze`、`/profiles/:id`、`/profiles/:id/exportable`、`/profiles/by-subject/:platform/:login`、`/job-postings*`、`/resumes/build`、`/auth/*`、`/interviews`、`/internal/cron/*`…） |
| 现有两个消费者身份完全不同 | Chrome 扩展走 HTTP API（依赖 `exportable`）；报告页是 Astro SSR **直读 storage**，不经 API |
| `GET /profiles/:id` 与 `/exportable` 是**公开**的 | `docs/API.md` §2 与 `design-auth-gating` 决策 #10：结论公开、证据原文登录才可见。profileId 同时出现在每条分享链接里 ⇒ 可被枚举 |
| 身份只有三态：`anonymous` / `demo`（HttpOnly Cookie）/ `user`（OAuth Cookie） | `apps/report/src/lib/auth.ts` 的 `resolveViewer` + `/demo/sessions`、`/auth/github/login` 与 `/auth/gitee/login` |
| **没有**服务到服务的凭证概念，唯一先例是 cron 共享密钥 | `/internal/cron/*` 用 `CRON_SECRET`（`timingSafeEqual` 比较），且生产环境缺该变量时**启动即失败**（`apps/api/src/index.ts:492-497` 的 T27 闸） |
| 画像投影 `exportable` 刻意不含证据 URL 与面试题 | `packages/shared` 的 `ExportableProfileSchema`：只有 subject / headline / skills(name,kind,depth,confidence,evidenceRefs) / authenticity(status,confidence)。`evidenceRefs` 是**内部 id**，不给 URL 就点不开 |

## 2. 设计原则（三条，违反任何一条就不该做这个面）

1. **MCP 面必须是 HTTP API 的薄壳，不许直读 storage。** 直读会绕过授权分级闸——那是产品承诺（"结论公开、证据原文登录可见"），不是实现细节。报告页直读是 SSR 性能取舍的历史产物，不能成为新表面的先例。
2. **服务账号不是人。** 今天所有"登录才可见"的判据都是"已登录的本人/招聘方"。一个带密钥的 agent 不等于一个人，因此**给密钥也不解锁**原始证据外链、面试题、`interview-kit.md`。要解锁必须先有"角色/授权"这条线（决策 #17 第二期），不能靠 MCP 先捅开。
3. **只读，且绝不触发采集。** `/analyze` 与 `/demo/sessions` 不进工具面：一次分析要烧 GitHub/Gitee 配额（demo 还扣会话配额），把它交给外部 agent 等于把成本开关交出去。外部要新画像，只能回到网页端由人触发。

## 3. 方案选项

| 方案 | 内容 | 判定 |
| --- | --- | --- |
| **A（推荐）** | 新增 `apps/mcp`：只读薄壳，进程内 `await createApp()`（`@jobagent/api` 已导出该工厂）并用 `app.request()` 自调，零网络、零新框架侵入业务，暴露 4 个只读工具 | 建议采纳 |
| B | MCP server 直连 `createStorage()` 读画像 | **拒绝**：违反原则 1，第一版就会把证据外链和面试题漏出去 |
| C | 不做服务面，只在 `docs/API.md` 加一节"给第三方 agent 的读法" | 兜底选项：如果 §7-1 定"暂不引入新依赖"，就走 C，本提案冻结 |

方案 A 对既有代码的改动量是**零**：`apps/api` 的 `createApp(deps)` 已是异步工厂且"被 import 时不启动监听"，形态 C 的报告页同域挂载（`apps/report/src/pages/api/[...slug].ts:16`）就是进程内复用它的生产先例（那里还专门做了温实例单例，避免每次重建路由与连接池——`apps/mcp` 应照此办理）。

## 4. v0 工具面（4 个，全部只读）

| 工具 | 映射端点 | 返回 | 明确不返回 |
| --- | --- | --- | --- |
| `get_profile` | `GET /profiles/:id/exportable` | 投影画像（主体、headline、技能+置信度、真实性 status/confidence）、`analyzerVersion`、`dataWindow` | 证据外链、信号 `detail` 原文、面试题、caveats |
| `lookup_profile_by_subject` | `GET /profiles/by-subject/:platform/:login` | `profileId` + `status`（`complete`/`partial`）+ `analyzerVersion` | 同上；`partial` 必须如实透出（它是终态降级，不会被升级） |
| `search_jobs` | `GET /job-postings` | 岗位列表（title/company/location/source/sourceUrl/新鲜度） | 内部打分细节 |
| `match_profile_to_job` | `POST /job-postings/match`（传 `profileId`）或 `GET /profiles/:id/job-recommendations` | 匹配分 + 逐技能命中理由（`skillReasons`）+ 命中字段分解 | 简历正文（`/resumes/build` 不进 v0，见 §6） |

**每个工具的 `description` 必须自带边界声明**（"这是可验证证据画像，不是打分排名；证据原文需登录网页端查看"），因为调用方是模型，描述就是它的政策。

## 5. 鉴权、限流与配额

- **凭证**：新增独立 secret `MCP_API_KEY`（不复用 `CRON_SECRET`，职责不同）。未配置 ⇒ server 只允许 `search_jobs`，画像类工具返回 `401 MCP_KEY_REQUIRED`；配置 ⇒ 四个工具可用。**密钥走环境变量注入，不入 Git、不进前端**（对齐 AGENTS 安全条）。
- **生产启动闸**：与 T27 同一条纪律——`isProduction && !MCP_API_KEY` 时启动即失败，而不是静默降级成"人人可用"。
- **限流**：`lookup_profile_by_subject` 与 `get_profile` 组合起来可按 login 枚举画像，这是**本提案新增的真实暴露面**（今天只有拿到分享链接的人才读得到）。因此 server 侧必须带固定窗口限流（建议按 key + 源 IP，默认 60 req/min），IP 只存加盐哈希（沿用演示模式既有做法，盐取 `DEMO_IP_SALT`），不落原始 IP。
- **配额**：MCP 只读 ⇒ **不扣 demo 配额、不占 Worker 并发闸**（那是给"触发新分析"设的）。这条要在实现前写死，避免有人顺手把 `/analyze` 接进来。

## 6. 非目标（v0 明确不做）

- 任何写操作：`/profiles/:id/claim`、`DELETE /profiles/:id`、applications/interviews 的增改。
- 触发分析与简历生成：`/analyze`、`/resumes/build`（后者要选岗位、要本地补填联系方式，且产物是投递材料——由人负责，不由 agent 代签）。
- B 端人才检索面（`/candidates`）：招聘方角色墙尚未建立（决策 #17 第一期只落了 F11 投递归属），今天开放它等于给匿名方做候选人库导出。
- LLM 润色链路（`polish:true`）：会真花钱，且只对登录 user 开放。
- 远程 HTTP/SSE transport 的公网部署：v0 只做 **stdio**（本机或 CI 里给 agent 用），公网形态等 §7-3 定完再开。

## 7. 三件待定（不采纳建议就不要开工）

1. **是否引入 `@modelcontextprotocol/sdk` 新依赖。** AGENTS 规定未经明确需求不引新框架/中间件。我的建议：**采纳**，但只装在 `apps/mcp` 一个包里，不进 `shared`/内核，且 v0 只用 stdio transport（依赖面最小）。若否 ⇒ 走 §3 方案 C。
2. **`MCP_API_KEY` 的默认姿态。** 建议：**未配置即拒绝画像类工具**（fail-closed），与 T27 的"上线开关缺失即启动失败"同纪律。备选：默认公开（等于把画像枚举面直接开放，我不建议）。
3. **`evidenceRefs` 要不要给。** 现在只给内部 id，调用方点不开。建议 v0 **维持不给**（与可见性矩阵一致）；若将来要给，前置条件是决策 #17 第二期的角色/授权线先落地，并单独升本提案版本。

## 8. 验收标准（实施时逐条勾）

- [ ] `apps/mcp` 只 import `@jobagent/api` 的 `app` 与 `@jobagent/shared` 契约，**不 import `@jobagent/storage`**（用一条测试断言模块图，防止日后有人抄近路）。
- [ ] 四个工具各有契约测试：入参 schema、返回字段集合快照、错误码（`MCP_KEY_REQUIRED` / `PROFILE_NOT_FOUND` / `INVALID_SUBJECT`）。
- [ ] **负向可见性测试**：带合法 key 调 `get_profile`，断言响应里 `http` 开头的证据 URL 数量为 0、无 `interviewQuestions` 字段。
- [ ] 限流可证伪：植入超过阈值的请求后确实被拒，且阈值内全过（正向对照）。
- [ ] 新 env 同步三处：`.env.example`、`docs/API.md`（或本文件）与部署执行单 E3 总表，由 `env-doc-consistency` 守护；本文件登记进 handoff「Project documents」与 `docs/README.md` 场景入口，由 `doc-links` 守护。
- [ ] `pnpm -r typecheck` / `pnpm -r build` / `pnpm -r test` / `bash tools/check-migrations.sh` / `git diff --check` 全绿；零迁移、零内核改动（**本提案不允许触碰 `analyzer-core` 与规则版本**）。

## 9. 工作量与顺序

| 步骤 | 内容 | 规模 |
| --- | --- | --- |
| M-1 | `apps/mcp`：stdio server + 4 工具 + 契约/负向测试（复用 `createApp()`，零既有代码改动） | 中（1 天） |
| M-2 | `MCP_API_KEY` + 限流 + 生产启动闸 + env 文档三处同步 | 小–中 |
| M-3 | README/handoff/docs/README 登记 + 试用说明（怎么在别的 agent 里配这条 MCP server） | 小 |
