# job-agent UAT 干跑验收单（2026-11-11）

## 范围
用 demo 会话 + 公开 GitHub 账号（octocat）跑通"画像生成 → 定向简历"链路。职位池、求职信两条路本轮未跑（原因见下）。

## 跑通的链路
1. `POST /demo/sessions` → 拿到 demo 会话（3 次 analyze 配额）
2. `POST /analyze {username:octocat, platform:github}` → 异步 job，约 16 秒完成
3. `GET /profiles/:id` → status=complete，解析出 9 个技能：JavaScript / HTML / CSS / node.js / react / backend / http / async / promise
4. `POST /resumes/build`（纯规则版，polish=false）→ 输出 markdown 简历 2905 字节

产出文件（生成产物，仅本地保留、未入库）：`docs/uat-dryrun/resume-octocat-ai-fullstack.md`

## 产物里实际观察到的行为（请逐条判）
- 标题自动概括："JavaScript 开发者，100 个公开仓库，在 GitHub 持续活跃 163 个月"
- 岗位匹配技能分档：node.js（有深度）、react（使用过）——与 JD 里"Node.js / React"对应
- 项目证据每条带 GitHub commit 链接，可回溯
- 诚实披露："已合并 0 个 PR，开过 8 个"——没有粉饰成"资深"
- 没有编造教育/工作经历/联系方式（画像里没有就不写）

## 本轮没跑通 / 没跑的
| 项 | 原因 |
|---|---|
| `POST /resumes/build` 带 LLM 润色（polish=true） | 未试，怕花 token；规则版已先看 |
| `POST /resumes/cover-letter` 求职信 | 代码里写死"仅登录 user 可调（LLM 付费）"，demo 会话 403 |
| 匹配打分的真实业务感 | octocat 是 GitHub 官方示例账号，仓库结构偏薄；用真实候选人账号会更有代表性 |

## 追加：独立 match 打分（2026-11-11 晚）
往 `job_postings` 表直接 INSERT 了 3 条合成职位（AI 全栈 / 前端 / 销售），用 octocat 画像调 `POST /job-postings/match`：

- 销售岗被过滤（不在 matches 里）——技能不相关的直接淘汰，行为正确
- AI 全栈岗 score=6：tags=4（node.js+react 命中），description=2（两技能在描述里各加 1）
- 前端岗 score=6：react 命中 tags+description，CSS 命中 tags
- 两个技术岗同分（octocat 技能集太薄，区分度有限）

产出文件（生成产物，仅本地保留、未入库）：`docs/uat-dryrun/match-result.json`

打分逻辑可解释：每个技能按命中字段累计（tags 权重 > description > title），且每个技能单独列出了 hit 来源。

## demo 会话能力上限（已确认）
| 端点 | demo 会话 | 登录 user |
|---|---|---|
| POST /analyze | ✅ 3 次配额 | ✅ |
| POST /job-postings/match | ✅ | ✅ |
| POST /resumes/build（polish=false） | ✅ | ✅ |
| POST /resumes/build（polish=true） | ❌ AUTH_REQUIRED | ✅ 已跑通，`applied=true`（需 `LLM_TEMPERATURE=1` + 大超时，见下） |
| POST /resumes/cover-letter | ❌ AUTH_REQUIRED | ✅ 已跑通，200 + 真实正文（同一组配置） |
| POST /job-postings/recruiter | ❌ 401 | ✅（需声明 recruiter） |

## 发现的真实 bug（2026-11-11 已修，真实上游验证通过）
**现象**：hack user 登录后调 polish=true，响应 `polish.applied=false, reason=provider_error`，静默回退规则版。

**根因是两个串联的阻塞点，不是一个**：

1. **temperature 被上游拒绝**。Ark `ark-code-latest` 只接受 `temperature=1`，其它值在生成开始前就回
   HTTP 400 `InvalidParameter: temperature only 1 is allowed for this model`。各 feature 的默认温度
   （polish 0.3 / cover-letter 0.4 / semantic 0.2 / JD 抽取 0.1 / L4 探针 0）全在被拒区间。
   hub 投影里**已经声明了** `adapter: { temperature: 1 }`，是 `apps/api/src/hub-catalog.ts` 的
   `resolveBuiltin()` 把它丢掉了。
2. **推理模型的思考耗时撞超时**。该模型会先产出大量 reasoning token 再写正文：实测一次润色
   `completion_tokens=4557`、求职信 `completion_tokens=2890`，对应墙钟 **136s / 83s**（同一 prompt
   多次实测落在 23s–136s+，方差很大）。客户端默认超时 30s，而 hub 投影路径**根本没读
   `LLM_TIMEOUT_MS`**，所以部署方调大这个值也不生效。

**上一轮的诊断是错的，此处更正**：旧记录写"返回 `content=""` / `finish_reason=length` / max_tokens 偏小"。
实测所有 temperature=1 的探针都是 `finish_reason=stop` 且正文非空，max_tokens 不是因素；
400 发生在生成之前，根本轮不到截断。基于该误判加的 `max_tokens: 2048` 默认值已撤回
（2048 反而可能截断更长的求职信）。

**修复**：
- `packages/llm`：客户端新增部署级 `temperature` 覆盖 + `llmTemperatureFromEnv` / `llmTimeoutFromEnv`；
  空正文错误保留 `finish_reason` 进 detail（便于区分预算耗尽与上游真没产出）。
- `apps/api/src/hub-catalog.ts`：投影 `adapter.temperature` 优先、env 兜底；两条客户端构造都读
  `LLM_TIMEOUT_MS`；`resolveBuiltin()` 补透传注入的 `fetchImpl`（此前漏传会让单测带夹具占位密钥
  打到真实上游，实测收到 Ark 401，违反"测试零网络"硬约束）。
- `apps/api/src/routes/resumes.ts`：在 I/O 边界落结构化失败日志（`polishResume` 的安全层是纯函数、
  把异常吞成 `provider_error`，不补这行日志线上就只剩一个无信息量的 reason）。
- 部署配置：`LLM_TEMPERATURE=1`、`LLM_TIMEOUT_MS=180000`。

**真实验证（登录 user，真实 Ark 上游，非单测）**：
| 端点 | 结果 | 耗时 | 计量 |
|---|---|---|---|
| `POST /resumes/build` polish=true | 200，`polish.applied=true` | 136.4s | prompt 696 / completion 4557 |
| `POST /resumes/cover-letter` | 200，真实正文 + provenance | 83.3s | prompt 762 / completion 2890 |

润色后数字全部保留（100 仓库 / 163 个月 / 8 PR / 0 合并），防臆造安全层未被绕过。

**和 zeus 的关系**：zeus 上轮按"max_tokens + 回落 reasoning_content"修的方向与本处实测不符，
需要按上面两条重新核对（本仓未改 zeus）。

## 另一个独立缺陷：合成岗位行过不了 schema（未修，待判）
直接 INSERT 的 3 条 UAT 职位 `source='uat'`，不在 `JobSourceSchema` 枚举
（remoteok/remotive/greenhouse/lever/hn_whoishiring/weworkremotely/jobicy/websearch/manual/recruiter）里，
所以 `POST /resumes/build` 走 `jobId` 分支一律 500 `stored job posting is invalid`。
本轮改用 schema 支持的 `posting`（粘贴 JD 直传，`source=manual`，不入库）绕过它完成验证。
`POST /job-postings/match` 不校验 source，所以上一轮 match 打分能跑通——两条路径口径不一致。

## 需要你判的（更新）
1. 规则版简历的"技能分档 + 证据回溯"这个粒度，你作为业务方认不认？
2. "有深度 / 使用过"这两档够不够，要不要加"入门 / 主导"等更多档？
3. 诚实披露 0 合并 PR 这种——你要保留还是要在简历里软化？
4. 下一轮是不是用你自己的 GitHub 账号（bayjf 之类）重跑一次，看真实画像质量？
5. ~~求职信要不要我找一条登录 user 的路径跑通~~ 已跑通（复用上一轮已存在的 hack 会话，未新造鉴权数据）。
6. **同步 HTTP 请求等 136s 可接受吗**？现在 polish/求职信是同步阻塞调用，推理模型实测 83–136s。
   要么接受长等待，要么改异步任务 + 轮询（产品改动，本轮未做）。
7. **`LLM_TIMEOUT_MS=180000` 这个部署值认不认**？本轮只在本地 `.env`（gitignored）改了它，
   compose 默认仍是 30000；生产要不要跟着调，或者换非推理模型。
8. 3 条 `source='uat'` 的合成岗位：改成合法 source（如 `manual`）保留，还是直接清掉？
