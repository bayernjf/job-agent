# Handoff 归档 — 2026-09-24

> 本文件冻结只读、不再追加。记录从 handoff 主文件裁出的 item50、item51 明细。
> 归档时 item50 已随 PR #77 并入 `main`；item51 为本地提交、尚未 push。

## 1. item50：部署前收尾批次 T1–T8（2026-09-23 晚）

4 个代码/素材原子提交 + docs(handoff)，已随 PR #77 合并：`174e878` build(extension) → `e37401a` docs(deferred) → `14f5023` docs → `2883207` fix(extension) → `0fc2bf2` docs(handoff)。

- **T4 release 一键打包**：新增 `apps/extension/scripts/release.mjs`（`pnpm --filter @jobagent/extension release`：强制 `EXTENSION_API_BASE` 为 https、注入 `EXTENSION_RELEASE=1` 构建、二次断言 dist manifest 无 localhost、manifest.json 位于 zip 根、macOS/Linux 系统 zip + Windows PowerShell Compress-Archive、已存在拒绝覆盖需 `--force`），占位生产域实测打包成功（13 files/422KB/grants 改写），验证包留在 gitignored `apps/extension/release/`。
- **T6 CWS 截图重截闭环（A1 遗留）**：在规则 0.3 英文画像 `32d41707`（bayernjf，2026-09-22 生成）上重跑 capture，挖出并修复 capture.mjs 三个真实问题：扩展先调 `by-subject` 而脚本未路由致匹配列表超时（补路由转发）、高级字段 localhost 是 placeholder 而非 value（清值无效，改为截图时替换 placeholder 为生产占位域并去焦）、Astro 7.3.2 无关闭 dev toolbar 的 CLI 开关（路由拦截 `/dev-toolbar/**` 脚本返回 204），7 张素材全部重新生成并逐张目检（无 localhost、无 toolbar、英文 claim、真实匹配/证据/填充）。
- **T5**：deferred-items 形态 C 触发点更新（认证清理 cron＝执行单阶段 E 的 Vercel Cron、扩展白名单＝阶段 F 用 release 脚本重打）并新增"上架前用生产 API release 构建重截"行。
- **T7**：文档过时扫描修正 4 处（README workspace 13→14 并补 release 命令、CONTRIBUTING 布局更新为 9+5、扩展 README 图标/分发/cover_letter 状态、store-assets README 一键打包段）。
- **T1**：handoff Git 状态段滞后修正。
- **T2/T3/T8 零改动验证通过**：jobs-sync secret guard 早已在（actionlint 1.7.12 exit 0）、`ASTRO_ADAPTER=vercel` report 构建 exit 0（item49 credentials 修复后 Vercel 不挂）、三个 tools 脚本在 macOS GNU bash 3.2 下 `bash -n` 与实跑行为正确。
- 剩余外部项：P0-3 形态 C 控制台部署、CWS 开发者账号与真实生产域重截、item45 待拍板。

## 2. item51：部署前最后一公里验证 + CWS 上架前准备（2026-09-24，macOS）

6 个本地英文原子提交（未 push）：`153bec9` feat(report) 双语隐私政策页 → `9ea1824` docs(privacy) 权威源 → `a3b22b8` docs(cws) 权限说明/listing → `be06a5d` fix(worker) lazy sources → `8940f30` test(smoke) locale 重定向断言 → `cd1a3c7` docs(handoff) item51 登记。

### A 组门禁（全绿）

- **A2**：Node v24 全量基线——typecheck、check-migrations 11 对 0 warning、单测 **835** 全绿、build exit 0。
- **A3**：Docker `postgres:16-alpine`（宿主 5434）生产方言回归——**11 对迁移幂等 + storage pg 行为 9/9**，含 advisory lock。
- **A4**：`ASTRO_ADAPTER=vercel` 产物预检——config v3、`_render.func` nodejs24/maxDuration300、同域 `/api` 路由。
- **A5**：node standalone 生产等价配置跑 `tools/smoke-deploy.sh` **自动项 7/7**。
- **A6**：`pnpm audit` 0 漏洞 + gitleaks v8.30.1 扫约 433 commits **0 泄露**。

### B 组 CWS 准备

- **B1**：中英双语隐私政策——权威源 `docs/privacy-policy-20260924.md`（10 节×2 语言：处理信息/不收集/用途/共享受托方/留存删除/国际传输/权利/未成年人/安全/变更联系）+ 在线页 `/[locale]/privacy`（content-as-data/全 token/`index,follow`）+ i18n 各 3 key（245→248）+ footer 入口 + E2E 4/4，报告 E2E 53→**57**。
- **B2**：store-assets 权限说明（Permission justifications 中英，明确无 tabs/history/cookies/scripting/webNavigation）。
- **B3**：listing 复核（补 Workday、Name 17、摘要 84/45、Node22→24 等过时注记）。
- **B4**：7 张素材 sips 校验全合规。
- **A7**：产出 [部署前就绪确认单](部署前就绪确认单-20260924.md)。

### smoke 预演挖出并修复的两个真实问题

1. `claimAndProcessOne` 在认领任务前就构造 source/校验 `GITHUB_TOKEN`，致空队列 cron 空窗期缺 token 返回 500 而非 idle——改为认领到任务（且非 demo 超闸退回）后才 lazy 构造，常驻 `runWorker` 仍启动 fail-fast，新增"空队列无 token→idle"守护单测（worker 27→28）。
2. smoke 脚本根 `/` 误期望 200（设计是无条件 302 locale 协商），改为断言 302 + Location 指向 `/en|zh-CN/`。

另确认迁移目录 bundle 错位仅影响"自动迁移"，形态 C 以 `DB_AUTO_MIGRATE=false` + 5432 预迁移规避（runbook 已规定），并实测该生产路径通过。

**结论：代码/产物侧上线门禁全部通过，唯一硬阻塞仍是 P0-3 形态 C 控制台人工部署；CWS 上架待生产域落地后 release 重打 + 填隐私政策 URL。**

## 3. 归档时 Git 同步态

归档动作发生在 2026-09-24 文档收尾批次；当时 `origin/dev` = `e823516`、`origin/main` = `50421c7`（Merge PR #77），本地含 item51 六提交 + 本 docs 归档提交（均未 push）。最终实况以 handoff 主文件「Git 状态」为准。
