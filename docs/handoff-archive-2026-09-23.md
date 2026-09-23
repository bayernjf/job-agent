# Handoff 归档 — 2026-09-23

> 本文件冻结只读、不再追加。记录从 handoff 主文件裁出的 item47、item48 明细，
> 以及 2026-09-22「自主推进七项加固」的最近变更明细。归档时 Git 同步态见文末。

## 1. item47：两端本地档案字段对齐（T1）+ PG 测试健壮性与真实验证（T2）+ 文档基线同步（T3）+ deferred 复核（T4）

2026-09-22，7 个代码/测试原子提交：`6e7b478` feat(shared) → `72eb784` feat(resume) → `bc77ca1` feat(report) → `ec20f2c` feat(extension) → `7104fbb` test(api) → `7e7ec2b` test(report) → `e1a155f` test(extension)。

- **T1 字段对称**（item46 遗留，呈现方式已拍板＝contact 行独立一项、填了才显示、中英都显示）：shared `LocalResumeFieldsSchema` 加可选 `linkedinUrl`（URL 校验），`localProfileToResumeFields` 去掉 `personalSite ?? linkedinUrl` fallback、两字段独立透传，legacy 迁移带 linkedinUrl；resume-core `buildContact` 与 markdown/html 在 contact 行独立渲染 LinkedIn（固定顺序 email·phone·location·personalSite·linkedinUrl·profileUrl，缺省省略）；报告页 ResumeBuilder 加 LinkedIn 输入、扩展面板加 personalSite 输入（ATS 投影 personal_website_url 早已支持，Greenhouse/Lever Website 随之可填），两端中英 i18n key 同构对齐。
- **T2 PG 测试健壮性**（评审 §五建议 3）确认已在代码：`describeError`（处理 embedded `start()` reject `undefined`）、`withTimeout`、`embeddedRunning`（启动失败不调 stop）、afterAll 限时 teardown。用 Docker `postgres:16-alpine`（宿主映射 **5434**，避让本机已占用的 5432 atlas-pg）设 `DATABASE_TEST_URL` 跑 postgres-behavior **7/7 全绿**；macOS embedded PG 复跑亦冷启动成功 **7/7**（initialise 3.1s / start 3.5s）——证明评审当日 FATAL 为**间歇性**环境状态而非稳定缺陷，且即使复现 FATAL 也安全 skip 不挂死。
- **T3 基线同步**：扩展浏览器 E2E 10 → **11**（新增两端 contact 输入共存用例）、报告 E2E **52/52**、全仓串行单测 **809 全绿**（shared 75 / extension 87 / analyzer 63 / resume-core 31 / storage 115 含 PG 7 / gitee 40 / github 24 / job-source 74 / llm 18 / cli 60 / worker 24 / api 157 / report 41）、typecheck/build 全 Done、check-migrations 11 对 0 warning、diff 干净。
- **T4**：全文复核 docs/deferred-items.md，无新增到达触发条件的缓做项（只读、无改动）。
- **flaky 留痕**：扩展 E2E 首个 `loadProfile` 用例（#3）在机器高负载下偶发 `.ja-result` 5s / `_harness` 等 `.ja-fab` 60s 冷启动超时；经 `git stash` 基线对照（基线 23.5s 过）与 T1 版空闲连跑 2 次（13.5s/6.5s 过）确认为 headless=new MV3 冷加载时序 flaky。**已由 item49（#113）加固闭环**。

## 2. item48：09-22 上线就绪评审 A 组本地闭环批次

2026-09-22，6 个英文原子提交：`e546d06` observability → `40d836b` docs 审计 → `21f1c9e` extension release 构建 → `975c6d6` report 跨端口修复 → `1e3975b` extension 空 base 回退 → `9ad1fbe` CWS 截图重截；A1–A7 全部完成。

- **A2/A4（前序会话完成）**：报告 E2E 52/52、扩展 E2E 11/11 复跑全绿；`ASTRO_ADAPTER=vercel` 生产构建本地通过，`.vercel/output/config.json` 确认 `^/api(?:/(.*?))?/?$ → _render` 同域路由映射（`.vercel/` 为未跟踪验证产物，不入库）。
- **A7 可观测埋点（`e546d06`）**：worker `processJob` 加 collect/analyze/persist/total 分段计时 + 各源 budget 汇总 + missing 计数；API `POST /analyze` 各出口加 `[analyze] result=...` key=value 日志（cache_hit、demo_required、ip_rate_limited、quota_exhausted、user/demo 的 dedup/queued，queued 带 remaining/cost）。worker 24/24、api 157/157 测试全绿。
- **A3 文档过时审计（`40d836b`）**：PRD §4.2 P1 节加 2026-09-22 实现状态注记（OAuth 认领/Gitee/异议入口/扩展均已提前落地，L3 未启动）；技术选型文档 V5 关闭（形态 C 拍板，指向部署执行单）、§6.11 容器+常驻 Worker 方案标注被形态 C 取代（Vercel Cron 替代）；docs/README 补决策 #15/#16；根 README 开头改为 09-22 评审结论并补形态 C 执行单/评审文档导航。
- **A6 CWS release 构建 + 上架 checklist（`21f1c9e`）**：`apps/extension/build.mjs` 新增 `EXTENSION_RELEASE=1`——从 dist manifest 剥离全部 localhost/127 grants、`EXTENSION_SITE_ORIGIN` 改写占位站点（默认 `https://job-agent.bayjf.com`）、API/site 为 localhost 时硬失败退出；dev 构建行为不变，四种情形（dev 保留 / release 剥离改写 / release 守卫拒绝 / 恢复 dev）实测通过。store-assets README 加 release 构建命令块与 8 条 Pre-submit checklist（域名决策、release 构建、截图重截、固定扩展 ID、图片尺寸、listing 文案、CWS 元数据与权限说明、生产 API 先上线），listing 文案复核 en summary 84 字符 / zh 45 字符与标注一致。
- **A5 demo 模式内置浏览器端到端复验（修复提交 `975c6d6`）**：本地 SQLite（三预置完整画像 + 2303 active 岗位）起 API（:3000，带 `DEMO_PRESET_LOGINS=github:torvalds,github:bayernjf,github:MSNightmare`）+ report（:4321）走真实 Chrome——①首页三预置「查看示例报告」秒进公开快照报告（不建会话、不扣配额）；②匿名提交新分析 → 403 DEMO_REQUIRED → 前端自动 POST /demo/sessions → 重发成功排队；③报告页 DemoBanner 正确显示「演示模式·本次演示还可发起 2 次新分析」（3→2 扣减正确）；④退出演示回匿名、banner 消失、公开报告仍可读。复验发现并修复一个**真实跨端口 dev bug**：AnalyzeForm/DemoBanner/PresetList 用 `credentials:'same-origin'`，跨端口（4321→3000）时会话 cookie 不落盘，自动建会话后重发仍 403、UI 报「HTTP 403」；统一改 `'include'`（与认证 islands 一致，同域生产行为不变），demo-flow E2E 5/5 全绿。另记录 dev 启动要点：`pnpm --filter @jobagent/report dev` 的 cwd 在 apps/report，`DB_PATH` 默认相对路径会落到 apps/report/data，本地联调须显式传绝对 `DB_PATH`。
- **A1 截图重截闭环（`1e3975b` fix + `9ad1fbe` assets，2026-09-22）**：用户用 `gh auth token` 解锁后，Node v24 下以新英文模板重跑 bayernjf 分析，生成新 complete 画像 `32d41707-2dd8-4632-a0c7-1aa52754cd59`（77 repos / 287 commits / 50 PRs，415 条证据行均为英文 claim）；release 构建扩展（host_permissions 仅 ATS 模式 + `https://job-agent.bayjf.com/*`）后重跑 capture.mjs，5 张截图全部重生成、sips 核尺寸 1280×800，01 不再暴露 localhost endpoint、02 证据行为英文 claim；capture 实测一键填充 6 字段（含英文 skills lead-in）。重截过程中修复一个真实缺陷：清空高级设置 API endpoint 输入后存入空串，background relay 报 "invalid URL"——panel 对空 base 统一回退构建期 DEFAULT_BASE（`1e3975b`，扩展 87/87 测试 + typecheck 全绿）。注：该会话环境无法渲染图片，未做逐张像素目检，以 capture 功能校验 + 文件尺寸为准。

## 3. 2026-09-22「自主推进七项加固」最近变更明细

8 个英文原子提交：`9aa377e` style(resume) 打印 PDF → `5100a18` test(storage) 并发配额 → `f99d55a` test(worker) 故障降级 → `566a677` feat(extension) 无障碍 → `01566ef` test(analyzer) 对抗样本 → `e1610d9` feat(report) 爬虫管控 → `e273cda` docs(api) + `fa3874f` test(api) 文档一致性。

1. 简历打印样式补 @page/A4/断页/print-color-adjust；
2. storage 钉死并发配额零超发（SQLite + 真实 PG，加权 cost-2 零部分扣减）与 IP 滑窗严格边界；
3. worker 故障注入三测（budget 重试、partial→insufficient_data、L0-only 证据保留）；
4. 扩展面板 ARIA（dialog/aria-pressed/alert/live/FAB aria-expanded）；
5. analyzer 对抗负样本（纯 fork、空时间线、2000 star 与 50:1 边界）；
6. recruit 页 noindex,nofollow + robots.txt 拦截 /api/ 与 recruit 路径 E2E；
7. API 文档↔注册路由双向一致性测试，顺带补文档 by-subject 端点。

验证：报告 E2E **53/53**、api **159**、扩展 E2E **11/11**。

## 4. 归档时 Git 同步态

归档动作发生在 2026-09-23 item49 批次（#113–116）收尾时；当时的 commit 链与 ahead/behind 实况以 handoff 主文件「Git 状态」为准。
