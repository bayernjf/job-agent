# Handoff 历史归档（2026-10-24）

> 归档惯例（对齐 agent-world，2026-09-18 起执行）：主文件只保留「项目当前状态 + 活跃任务 + 最近变更 + 文档索引」；编号待办标 ✅ 后，详细过程（实现步骤 / commit 链 / 踩坑 / 验证数据）整块滚入本类文档，主文件只留**一行结论 + commit hash**。归档文件冻结只读、不再追加。
> 本归档对应：被「最近 5 条变更」限额挤出的 2026-10-14 流水（B 端 pipeline 状态机 B3-b，item164）。挤出原因＝2026-10-24 新增一条「全面代码审查」变更。

## §1 B 端 pipeline 状态机 B3-b（item164，2026-10-14/15，决策 #25 授权）

原文（2026-10-24 从主文件「最近变更」整块迁入，内容未改）：

- 2026-10-14（**B 端 pipeline 状态机 B3-b，item164，决策 #25 授权**）：见活跃待办 item164 全文。要点：迁移 039 双方言（`applications.stage` + `application_events` 只追加事件流）、`advanceStage` CAS+同事务事件、三端点（推进/事件回放/岗位投递列表）、`/recruit` 投递区推进按钮（含首推进 null→new 缺口修复）、`ApplicationTracker` stage 徽标。设计见 [docs/design-b3b-pipeline-state-machine-20261014.md](design-b3b-pipeline-state-machine-20261014.md)。storage 280 / api 430 / report 244 全绿，`check-migrations.sh` 39 对 0 warning，E2E recruiter-postings 3/3。**生产迁移 039 已于 2026-10-16 执行**（随 item165 的 040 同批 `pnpm migrate:pg:up`，幂等）；B3-c 仍卡 B2-b。

> 明细全文见主文件「活跃待办」item164 与 [docs/design-b3b-pipeline-state-machine-20261014.md](design-b3b-pipeline-state-machine-20261014.md)；端点契约见 [docs/API.md](API.md) §3.6。
