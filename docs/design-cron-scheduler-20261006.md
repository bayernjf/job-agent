# 分析任务消费的定时器选型（GitHub Actions 轮询 → Cloudflare Worker Cron）

> **状态：✅ 已拍板并落地（决策 #24，2026-10-06）**。用户拍板＝**采纳方案 C / 5 分钟档 / 代码放 `apps/cron-worker/`**。Worker 已部署，UTC 20:10 真实档位 tail 抓到 `[cron-worker] tick processed=0 idle=true agentTick=200`（到点触发 + secret 正确 + agent-tick 通三者同证）；GitHub 轮询暂留交叉验证、2–3 天后移除 `schedule`。决策对象＝「谁在生产里按分钟叫醒 `process-job`」。现有实现见 [.github/workflows/cron-poll.yml](../.github/workflows/cron-poll.yml)，缓做登记见 [deferred-items「分析任务消费的调度密度」](deferred-items.md)，部署背景见 [deployment-runbook-20260920.md](deployment-runbook-20260920.md) 与 [部署执行单-形态C-20260921.md](部署执行单-形态C-20260921.md) E1。

## 1. 问题

形态 C 没有常驻 Worker：分析任务的消费靠定时器打 `GET /api/internal/cron/process-job`（`apps/api/src/routes/system.ts:57`）。Vercel Hobby 每天只允许 1 次 cron，所以这个端点改由 GitHub Actions 的 `schedule` 承担（`.github/workflows/cron-poll.yml:38`）。

**实测：GitHub 的 schedule 不是"慢一点"，是"经常根本不跑"。**

| 时间（UTC） | 事实 |
|---|---|
| 2026-10-01 ~ 10-05（每小时档） | 相邻 run 间隔实测 **4–7.5 小时**，约 3–4 次/天 |
| 2026-10-05 18:04 | `*/15` 档随 PR #143 合并进 main |
| 2026-10-05 16:12:36 | **最后一次 scheduled run** |
| 2026-10-05 19:13（实查时刻） | 距上次 run **3 小时零触发**；改档后应触发的 18:15/18:30/18:45/19:00 四档**一个都没跑**，也没有 queued/in_progress |

复现命令：

```bash
gh run list --workflow=cron-poll.yml --limit 20 --json createdAt,event,conclusion --jq '.[] | "\(.createdAt) \(.event) \(.conclusion)"'
```

**这不是配置错误**：工作流 state=active、表达式在 main 上确认无误、三个 secret 齐备、已跑过的 run 全部 success。丢的是 GitHub 的调度器本身，不是我们的代码。

影响是产品级的，不是"体验略差"：

- 新用户提交分析后要等**数小时**才有结果（`/my` 会如实显示"仍在排队"，见 handoff item122，但"如实"不等于"可接受"）；
- `agent-tick` 走同一次轮询，求职工作台的任务推进被同一根绳子拖着。

## 2. 目标与非目标

**目标**：让 `process-job` 的消费间隔稳定在分钟级，且**不改变任何 API 契约、不动内核**。

**非目标**（明确不做）：
- 不引入消息队列 / Redis（AGENTS 硬约束）；
- 不改 `analyzer-core` / worker / storage；
- 不动 Vercel 那条每日 `cleanup` cron——每天 1 次本来就够，Hobby 免费且已跑通；
- 不做事件驱动（"入队即消费"要求常驻进程或队列，属另一个量级的改造）。

## 3. 三个选项

| | A 维持现状 | B 升 Vercel Pro | C Cloudflare Worker Cron（**推荐**） |
|---|---|---|---|
| 间隔 | 名义 15 min，实测数小时且不可预测 | 1 min（Vercel Cron 原生） | 5 min（可配到 1 min） |
| 月成本 | 0 | 约 $20 | 0（免费档余量极大，见 §4.5） |
| 新增面 | 无 | 无（改计划 + `vercel.json` 加一条 cron） | 一个新 Worker（约 30 行）+ 一份 wrangler 配置 |
| 可靠性 | 差（已实测） | 高 | 高（到点即触发；配置变更传播 ≤15 min） |
| 回滚 | — | 降回 Hobby，cron 自动失效 | 清空 `triggers.crons` 或删 Worker |
| 外部依赖 | GitHub Actions | Vercel 计费 | Cloudflare 账号（**已在用**：DNS + 落地页 Pages） |

A 已被实测否掉。B 是"花钱买确定性"，最省事，但每月固定支出，在还没有真实外部用户前不划算（deferred 里记的就是这个判断）。C 用**已经在用的** Cloudflare 账号拿同样的确定性，代价是多一个部署面。

## 4. 方案 C 设计

### 4.1 拓扑

```
Cloudflare Cron (*/5) ──► Worker ──► GET {PROD}/api/internal/cron/process-job
                                  └► GET {PROD}/api/internal/cron/agent-tick
        Authorization: Bearer $CRON_SECRET（与 Vercel Cron 同一凭证形态）
```

Worker 不碰数据库、不复制任何业务逻辑，只做"叫醒 + 看门"——与 `apps/mcp` 的薄壳原则同构。

### 4.2 Worker 行为

每个 tick：

1. 循环调用 `process-job`，直到返回 `outcome.kind === 'idle'` 或达到上限（建议 10 次，与现有 workflow 一致）；
2. 调一次 `agent-tick`；
3. 任何非 2xx 立即停止，把状态码写进 `console.error`（`wrangler tail` 可看）。

**照抄现有 workflow 的两条语义，不重新发明**：
- **不吞错**：401/403/5xx 不重试、不静默，记日志后退出（下一档再来）；
- **幂等**：队列空时 `process-job` 返回 200 `idle`，重复触发无害。

### 4.3 与 GitHub 轮询的关系：先并存，后择一

两个调度器同时存在是**安全的**，因为认领是原子的：

- 仓储契约写明 `claimNext` 为原子认领（`queued → running`，正式优先、同级 FIFO）——`packages/storage/src/repositories/analysis-jobs.ts:11`；
- Postgres 实现是条件 `UPDATE ... WHERE id = ? AND status = 'queued' RETURNING id`，两个调用者抢同一行时只有一个拿得到——`packages/storage/src/postgres/analysis-jobs-repo.ts:42`。

所以并发调用最坏是"一个干活、一个拿 idle"，不会重复处理同一作业。

**建议：Worker 上线后保留 GitHub 轮询 2–3 天做交叉验证，确认 Worker 的实测间隔稳定后，再把 `cron-poll.yml` 的 `schedule` 段删掉，只留 `workflow_dispatch` 作手动探活。**

### 4.4 密钥与配置

- `CRON_SECRET`：用 `wrangler secret put CRON_SECRET` 写入（密文，不进仓库、不进 `wrangler.jsonc`）；
- 生产源：普通变量 `PROD_ORIGIN = https://app.job-agent.bayjf.com`（非密级）；
- 端点只认 `Authorization: Bearer`（`?token=` 已于 2026-10-05 从服务端移除），与 Vercel Cron 的凭证形态完全一致——`apps/api/src/index.ts:186`。

### 4.5 免费额度核算（Cloudflare 官方文档当期值，2026-10-06 核实）

| 项 | 免费档 | 本方案用量 |
|---|---|---|
| Cron 触发粒度 | 最小 1 分钟 | 取 5 分钟 |
| Worker 调用次数 | 100,000/天 | `*/5` = **288/天**（即使 1 分钟档也才 1440/天） |
| 每次调用子请求数 | 50 | 最坏 11（drain 10 + agent-tick 1） |
| 每次触发 CPU | 10 ms | 只有 `fetch`，**网络等待不计 CPU** |
| 账号 Cron 触发数 | 5 | 用 1 |

余量极大。**唯一要守的红线：drain 上限不要调到 50 以上**（那是子请求上限）。

### 4.6 可观测性

- 实时：`wrangler tail <worker-name>`；⚠️ **本机实测不成立**（2026-10-07）：`watch.cloudflare.com` 直接 ENOTFOUND，不走代理时撞被污染的 DNS（ETIMEDOUT 到 `199.96.63.75`），必须带 `HTTPS_PROXY` 才连得上——"随时能 tail"是有前提的。
- 历史：Cloudflare 面板 → Workers → 该 Worker → Cron Events / Logs（**只有浏览器里看得见**，没有 API/进程在读）。
- ~~失败信号与"GitHub run 变红"等价~~ **这句已被 2026-10-07 复核作废**：`console.error` 只是躺在日志里，`apps/cron-worker/src/index.ts` 除两行 `console.error` 外没有任何状态回写、指标或告警接线，**没有任何人或程序会读到它**；GH run 变红至少是可枚举的（`gh run list`）。等价不成立 ⇒ 已登记为缓做项（[deferred-items.md](deferred-items.md)「Cron Worker 的失败信号没有任何读者」），**在删掉 `cron-poll.yml` 的 `schedule` 段之前先补上站内可读**，否则"没人消费队列"这件事在系统内不可观测。

### 4.7 回滚

清空 `triggers.crons`（保留 Worker 便于复跑）或直接删 Worker。**两者都不影响生产运行时**——端点只是不再被高频叫醒，回到今天的形态；GitHub 轮询若还留着会继续兜底。

## 5. 代码放哪（待定，两个选项）

| | `apps/cron-worker/`（workspace 包） | `tools/cron-worker/`（独立目录，仿 `tools/resume-pdf-spike`） |
|---|---|---|
| 与仓库门禁 | 进 `pnpm -r typecheck`/`build`，需装 `@cloudflare/workers-types` 与 wrangler | 不进 workspace，独立 `pnpm install --ignore-workspace` |
| 好处 | 与产品代码同仓同 CI、类型受守护 | 不给主仓增加 Cloudflare 依赖与构建面 |
| 代价 | 主仓多一个与 Node 运行时无关的包（Dockerfile、CI 都要考虑） | 门禁覆盖弱一些 |

**倾向 `apps/cron-worker/`**：它是生产基础设施而不是一次性实验，理应受 CI 守护；但这条路要连带走一遍"新增 workspace 包"的清单（Dockerfile COPY、`dockerfile-workspace` 守护、CI）。**这一项请一并拍板。**

## 6. 验收（缺一条不算落地）

1. **实测间隔**：部署后 24h，Cron Events 或 `wrangler tail` 显示实际触发间隔 ≤ 名义档位 + 少量抖动（对照今天 GitHub 的 3 小时空窗）。
2. **端到端**：生产提交一次真实分析 → 到结果可见的耗时 ≤ 一个档位 + 单任务处理时间。
3. **反证**：把 Worker 的 `CRON_SECRET` 改成错值 → 日志出现 401 且**不重试**；恢复后回到 200。
4. **并发无害**：Worker 与 GitHub 轮询同时开 24h，作业不被重复处理（认领原子性已有单测，这里验真实并存）。
5. **零回归**：`apps/report/vercel.json`、`cron-poll.yml`（若保留）、API 契约与画像输出逐字节不变。

## 7. 风险与未决

- **多一个部署面**：`CRON_SECRET` 轮换要跟着做两处（Vercel env + Worker secret）。
- **Cloudflare 账号成为硬依赖**：今天它只承载 DNS 与落地页；Worker 上线后定时消费也挂在同一账号下。若账号出问题，DNS 本来就已经受影响，边际风险有限。
- **未决（请拍板）**：① 是否采纳方案 C；② 档位取 5 分钟还是 1 分钟；③ 代码放 `apps/` 还是 `tools/`；④ 上线后是否移除 GitHub 轮询的 schedule（本文建议保留 2–3 天后移除）。

## 8. 明确不做

- 不做事件驱动 / 队列（要常驻进程或引入中间件，违反 AGENTS 约束）；
- 不在 Worker 里直连数据库或复制任何业务逻辑；
- 不用 Worker 替代 Vercel 的每日 `cleanup` cron（那边免费且够用）；
- 不因为这条改动去动 `analyzer-core`、worker 或任何画像输出。
