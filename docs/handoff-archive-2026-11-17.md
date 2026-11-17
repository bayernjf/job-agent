# Handoff 历史归档（2026-11-17）

> 归档惯例（对齐 agent-world，2026-09-18 起执行）：主文件只保留「项目当前状态 + 活跃任务 + 最近 5 条变更 + 文档索引」。归档文件冻结只读、不再追加。
> 本归档对应：验证期决策与备份失败处置条目入列后超出「最近 5 条变更」限额的 10-31 restore 验证一条，从主文件整块迁入，内容除链接层级修正外未改。

## §1 被挤出的「最近变更」原文

- 2026-10-31（**分段备份端到端 restore 验证通过——新格式首次被证明可恢复，零产品代码改动**）：对 `backup-20261031-034825` 全套产物做真实恢复演练（一次性 PG17 容器，用完即删，生产零写入）。**结论＝可恢复且逐表相等**：主转储用 `pg_restore -l` 过滤出 **public schema 450 项**后 `--use-list` 恢复 **exit 0 / 29 张表**（不过滤会在原版 PG 报 `supabase_vault` 扩展不可用——dump 默认把 Supabase 平台 schema auth/storage/realtime/vault 等 395 项也打进去了）；10 个 CSV 分块以 `\copy … NULL '\N'` 全部干净灌入，`job_postings` = **19,035 行与 state 账本一致**；13 张关键表（profiles 8 / accounts 2 / evidence 1689 / job_runs 2〔即待真人提交的两条〕/ job_run_events 426 / analysis_jobs 14 / auth_sessions 6 / search_runs 5 / funnel_events 14 / usage_events 6 / cron_heartbeat 5 / user_llm_configs 1 / public schema_migrations 41）**恢复库与生产逐表相等**。**顺带修好本地备份脚本**（gitignored `backups/ja-chunk-dump.sh`）：pg_dump 加 `--schema=public`，今后每周分段备份的主转储不再打包平台 schema、无需 TOC 手术即可直接 `pg_restore`（public 无扩展依赖，gen_random_uuid 为 PG13 内置）。**注意两个坑**：① `pg_restore … | head` 会 SIGPIPE 把恢复中途掐断、留下半套对象（本次实测），演练时全量落盘日志；② 跨容器用 `host.docker.internal:<发布端口>`（默认网桥无 DNS）。至此 B4 备份体系闭环：每周分段备份（已做 10-31）+ 真实恢复验证（本条）+ 旧集清理（仍待用户点头）。
