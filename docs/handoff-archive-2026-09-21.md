# Handoff 历史归档（截至 2026-09-21）

> 本文件为 [handoff.md](../handoff.md) 的历史归档。按归档惯例（对齐 agent-world：主文件只保留「项目当前状态 + 活跃任务 + 最近 5 条变更 + 文档索引」；编号待办标 ✅ 后详细过程整块滚入归档、主文件只留一行结论 + commit hash），本归档从主文件移出 **item37 代码侧已完成部分、item38–item40、item42–item44** 的明细与 2026-09-21 的最近变更流水。**只读、不再追加**；新变更直接写主文件，主文件同步态以此为准。
> item30–36 明细见 [handoff-archive-2026-09-20.md](handoff-archive-2026-09-20.md)；item28/29 见 [handoff-archive-2026-09-19.md](handoff-archive-2026-09-19.md)；item 1–27 见 [handoff-archive-2026-09-18.md](handoff-archive-2026-09-18.md)。
> 编号说明：actionlint CI、Windows 跨设备验证、归档维护三项于 2026-09-21 在 Windows 克隆完成（当时临时编号 item41/42/43），因跨设备未同步、提交未 push 且已在 Windows 本地丢失，2026-09-22 在 macOS 侧按当前 handoff 编号重建为 **item42/item43/item44**（macOS 的 item41 为 2026-09-22 的 claim 英文化，见主文件，未在本归档范围）。

## 1. item37 代码侧已完成部分：MVP 评审 P0-1/P0-2 修复 + #14 合规拍板（2026-09-21，已随 PR #70 合入 main）

**P0-1 ✅ worker 成功分支补 evidence 落库（`80b8a81` fix(worker)）**：成功分支在画像快照后调 `evidence.importFromProfile(profileId, analyzerInput.evidence)`（源无关、融合去重后的证据），`WorkerRepos` 补 evidence 仓储，夹具证据改非空并加落库断言；worker 24/24。**P0-2 ✅ 报告页 mailto 异议入口（`3babb8f` fix(report)）**：报告页局限区改为始终渲染，新增 mailto 异议链接（主题带画像 id）、`report.dispute.subject/body` 中英 key、`PUBLIC_DISPUTE_EMAIL` 覆盖（默认 dispute@job-agent.bayjf.com），E2E 加链接断言；report 单测 33/33、E2E 52/52。**#14 合规与 demo 配额拍板并落地**：①画像快照与证据长期留存、不自动过期，任何用户可经报告页异议 mailto 申请删除；②分享链接不自动过期、应求撤销，同一通道；③demo 每会话 3 次新分析（单源扣 1/融合扣 2），会话有效期 24h——`DEMO_SESSION_TTL_MS` 默认值由 7 天改为 `86400000`（demo-config.ts/.env.example/demo 设计文档/待拍板清单 #14 同步记录），demo.test.ts 的 Max-Age 与 expiresAt/resetAt 断言改 24h；验证（Node v22.23.1）：API 全量 150/150。**仅剩 P0-3 形态 C 真实部署（控制台操作需用户本人，见主文件活跃项）**；法务对自动化决策用于雇佣的最终意见仍待外部。

## 2. item38 评审非阻塞小瑕疵收尾 + 形态 C 同域挂载守护测试（2026-09-21，已随 PR #70 合入 main）

①**CLI `analyze` 接通 `--format json|markdown|html`**（usage 文案长期承诺但 parseArgs 未注册，传入即报错；复用此前零调用的 `renderProfile`，默认 json 不变，非法值退出 2，+3 单测，CLI 20/20）。②**报告页形态 C 同域行为补守护**——新增纯函数 `stripApiPrefix`（从 `pages/api/[...slug].ts` 抽出，钉死 `/api`→`/`、`/api/auth/github/callback`→`/auth/github/callback`、`/api-docs` 不误剥等边界，4 单测）与 `resolveBrowserApiBase`（`api-base.ts` 解析逻辑抽纯函数，钉死显式 PUBLIC_API_BASE 优先 / Vercel 回落 `/api` / 本地空串，4 单测；PUBLIC_* 经 Vite 静态替换、vi.stubEnv 改不到，故测可注入纯函数），report 单测 33→41。验证（Node v24.0.0）：全仓 typecheck/单测（api 150、report 41、CLI 20）/build、`ASTRO_ADAPTER=vercel` 构建、check-migrations 0 warning、报告 E2E 52/52 全绿。**至此纯代码侧可闭环项全部清空，剩余仅 P0-3 控制台部署与外部项**。

## 3. item39 形态 C 部署执行包（2026-09-21，已随 PR #70 合入 main）

把 Runbook 形态 C 落成照勾执行的 [docs/部署执行单-形态C-20260921.md](docs/部署执行单-形态C-20260921.md)（A–J 阶段 + Vercel env 总表 + 故障速查；纠正 `demo seed` 为只读就绪检查、真正预热用 `jobagent analyze <login>`，`DEMO_PRESET_LOGINS` 默认空、生产须显式配 `github:torvalds,github:bayernjf,github:MSNightmare`）+ 两个对齐 `tools/check-migrations.sh` 风格的只读脚本：`tools/gen-deploy-secrets.sh`（生成 CRON_SECRET/AUTH_STATE_SECRET/DEMO_IP_SALT，`--out` 写 chmod 600、文件存在拒绝覆盖，真实密钥不入库）、`tools/smoke-deploy.sh`（部署后验 `/api/health`、首页/`/en/`、cron 无 token→401/带 token→200、未知 job→404、presets→200，末尾打印人工 checklist）。**Supabase/Vercel Pro/域名 DNS/生产 OAuth/Actions secret/首次 5432 迁移等控制台操作仍只能用户本人执行（P0-3）**。

## 4. item40 Chrome Web Store 上架素材包 + 顺带修复四个真实扩展缺陷（2026-09-21，已随 PR #70 合入 main）

`apps/extension/store-assets/`（不打包进 dist）产出合规素材——5 张 1280×800 截图（扩展匹配面板 / 匹配依据证据 / 一键填充结果 / 英文可信画像报告 / 招聘方人才库）+ 必需 440×280 小宣传图 + 可选 1400×560 marquee（sips 核验尺寸全部精确合规）+ 可复现 `capture.mjs`（Playwright：真实本地 API 数据、仅 ATS 宿主页 mock、强制 `locale:'en-US'`）+ 高仿真 Lever `ats-job.html`、`promo.html` 与 README（官方规格出处、复现命令、中英 listing 文案；规格取自 developer.chrome.com 官方仓库 raw markdown，**现版无 920×680**，截图 1280×800 直角 full bleed）。截图过程挖出并修复四个真实缺陷：**填充覆盖**——①`collectFields` 漏收 `input[type=tel|url]`，致真实 Lever 电话 / LinkedIn / GitHub 字段填不进；②`findLabeledQuestion` 对 label 与字段平铺（无包裹 div、无 id-for）的表单误取容器首个 label，动机问题漏填，补「紧邻前兄弟 `<label>`」优先匹配；**样式呈现**——③manifest 缺 `web_accessible_resources` 致 content script 注入的 tokens/panel.css 在真实网页被拒（面板裸样式；WAR matches 用 `https://*/*`，content_scripts 式 path 通配会使扩展整体加载失败）；④长面板无 max-height 顶部溢出且与悬浮按钮重叠（加 `max-height: calc(100vh - 96px)` + 内部滚动，保留 fab 作唯一收起入口）。扩展单测 15→17、E2E 补样式回归断言且 9/9，浏览器实测一键填充由 2 字段增至 6 字段（name/email/phone/linkedin/github/why）。**待外部：CWS 开发者账号上架、生产 API 构建重截（去掉高级字段 localhost placeholder）**。

## 5. item42 CI 补 actionlint job（2026-09-21 于 Windows 克隆首建，2026-09-22 在 macOS 重建为 item42，本地提交 `a2d949a` ci，未 push）

`.github/workflows/ci.yml` 在 `jobs:` 下新增独立 `actionlint` job：`actions/checkout@v7` 后 `docker run --rm -v "$PWD":/repo -w /repo rhysd/actionlint:1.7.12 -color`（镜像 tag 钉死 `1.7.12`，与本地验证版本一致），push/PR 自动静态校验全部 workflow（ci.yml、jobs-sync.yml），不再依赖手动本地跑。落地前用 actionlint 1.7.12 验证：Windows 侧用 v1.7.12 windows_amd64 二进制扫描改动前后均 exit 0；macOS 重建后用 Docker 跑同一镜像全量扫两个 workflow exit 0、零告警。commit message：`ci: add actionlint job to lint workflows`（英文祈使句 + 英文 body 说明目的）。pre-commit（全仓 typecheck）通过。

## 6. item43 Windows 跨设备 Node v24 全量验证回归（2026-09-21 于 Windows 实跑，2026-09-22 在 macOS 重建记录为 item43，本地 docs 提交未 push）

Windows 11 Pro（10.0.26200）+ PowerShell 5.1 + git 2.54 + fnm Node **v24.0.0**（＝`.nvmrc` 权威；机器上另有 node24 目录 v24.11.0 与系统 PATH v22.23.2 均不采用）+ pnpm 10.12.1，全新 clone 到 `C:\Users\24670\000mycodes\job-agent`（dev，head=2e906e8），`pnpm install --frozen-lockfile`（523 包、15 workspace 项目；@embedded-postgres/windows-x64 hydrate、better-sqlite3@12.11.1 在 Node24 本机编译为 **abi 137**、husky prepare 成功）。复跑全部门禁，**与 macOS 权威基线逐项一致、零代码改动**：

| 门禁 | Windows 11 实测 | macOS 基线 |
| --- | --- | --- |
| `pnpm -r build` | EXIT 0（14/15 workspace，根包无 build） | 全过 |
| `pnpm -r typecheck` | EXIT 0，全包 0 error | 全过 |
| 串行单测 `pnpm -r --workspace-concurrency=1 test` | **13 套 781/781、0 失败**（74/68/63/30/115/40/24/74/18/60/24/150/41；storage 14 文件 **115/115**，含 **Windows 真实 embedded PostgreSQL 7/7**） | 13 套 781 |
| storage 真实 embedded PG | initialise 22.8s / start 23.8s / createDatabase 26.9s、文件 47.5s，在已放宽的 120s hook 内通过 | 6–39s 冷启动 |
| `bash tools/check-migrations.sh` | sqlite/postgres **11 对、0 warning** | 11 对 0 warning |
| 报告 Playwright E2E `pnpm e2e` | **52/52（2.2m，webServer 自动起 Astro + fixture SQLite）** | 52/52（约 1.9m） |
| 扩展 E2E `pnpm e2e:extension` | **9/9（30.5s，先 build MV3、`--headless=new` 零网络）** | 9/9（约 30.5s） |
| `git diff --check` | 干净、零迁移 | 干净 |

**两个环境假象（已实证，避免后人误判）**：①**pnpm 引擎警告误报**——`fnm exec` 下 `pnpm install` 仍打印 `Unsupported engine: wanted >=24.0.0 (current: v22.23.2)`，经探针证实为**外观性误报**：`fnm exec --using=24.0.0 -- node -v`=v24.0.0、`pnpm exec node -p process.version`=v24.0.0；在 packages/storage 放临时探针（已删）证明 better-sqlite3 原生绑定 **ABI=137**，在 v24.0.0 下建表增查 OK、在系统 v22.23.2 下直接加载失败——而全部 SQLite 测试通过，反证生命周期命令实际跑在 Node 24。②**后台执行器假 exit 1**——fnm/node 把弃用提示（DEP0169/DEP0176）写往 stderr，被 PowerShell/执行器包装成 NativeCommandError 假失败；以日志 `=== PHASE x EXIT 0 ===`/`ALL PHASE1 DONE` 标记与 `$LASTEXITCODE` 为准（phase-1 日志与 ABI 探针证据存于 Windows `%TEMP%\ja-validate*.log`、`ja-abi-probe3.txt`，可复跑）。跨设备门禁通过的意义：CI 始终以 ubuntu runner（postgres:16-alpine service、`DATABASE_TEST_URL`）为准，Windows 本地复跑证明门禁在第二个开发环境同样全绿。

## 7. item44 handoff 归档维护（2026-09-22，本批重建，本地 docs 提交未 push）

按归档惯例把本文件从主文件「最近变更」移出的 2026-09-21 流水（见 §8）与编号待办明细（item37 已完成部分、item38–40、item42–43）滚入归档；主文件恢复「当前状态 + 活跃任务 + 最近 5 条变更 + 文档索引」，活跃待办压成一行结论 + commit hash；Project documents 登记本归档行；[docs/README.md](../docs/README.md) 归档场景行补 09-21 入口。

## 8. 最近变更流水（2026-09-21 从主文件移出）

- 2026-09-21：**CWS 上架素材包 + 修复四个真实扩展缺陷（item40，已随 PR #70 合入 main）**——产出 `apps/extension/store-assets/`（5 张 1280×800 截图、440×280 必需图、1400×560 marquee、`capture.mjs`、`ats-job.html`/`promo.html`/README 中英 listing）。截图首跑暴露并修复四个真实缺陷：**填充**——`collectFields` 补收 `input[type=tel|url]`（真实 Lever 电话/LinkedIn/GitHub 原填不进）、`findLabeledQuestion` 补「紧邻前兄弟 label」匹配（平铺无包裹的动机问题原漏填）；**样式**——manifest 补 `web_accessible_resources`（content script 注入的 tokens/panel.css 原在真实网页被拒；matches 用 `https://*/*`）、`.ja-panel` 加 `max-height: calc(100vh - 96px)`+内部滚动（原长面板顶部溢出并与 fab 重叠）。扩展单测 15→17、E2E 9/9，浏览器实测一键填充 2→6 字段。待外部：CWS 开发者账号上架、生产 API 构建重截。
- 2026-09-21：**形态 C 部署执行包（item39，已随 PR #70 合入 main）**——新增照勾执行的 [docs/部署执行单-形态C-20260921.md](docs/部署执行单-形态C-20260921.md)（A–J 阶段、Vercel env 总表、故障速查）与 `tools/gen-deploy-secrets.sh`、`tools/smoke-deploy.sh`，docs/README 补场景入口；纠正 `demo seed` 是只读就绪检查、`DEMO_PRESET_LOGINS` 默认空须显式配三预置账号。控制台步骤仍只能用户本人执行。
- 2026-09-21：**评审非阻塞小瑕疵收尾 + 形态 C 同域挂载守护测试（item38，已随 PR #70 合入 main）**——①`feat(cli)`：`analyze` 接通 `--format json|markdown|html`（+3 单测，CLI 20/20）；②`test(report)`：`stripApiPrefix` 与 `resolveBrowserApiBase` 两个纯函数守护（report 单测 33→41）；③`docs(handoff)`。验证：全仓 typecheck/单测（api 150、report 41、CLI 20）/build、`ASTRO_ADAPTER=vercel` 构建、check-migrations 0 warning、报告 E2E 52/52 全绿，零迁移。**纯代码侧再无可闭环项，进度全部取决于 P0-3 控制台部署。**
- 2026-09-21：**MVP 上线评审接力（item37）**——对照 live 源码独立复核评审结论后修复两个代码级 P0：①P0-1（`80b8a81` fix(worker)）成功分支补 evidence 落库；②P0-2（`3babb8f` fix(report)）报告页 mailto 异议入口。验证（Node v22.23.1）：worker 24/24、report 单测 33/33、Playwright E2E 52/52。P0-3 形态 C 部署与 #14 留存删除/配额 TTL 拍板仍需用户参与。
- 2026-09-21：**#14 合规与 demo 配额拍板并落地（item37）**——①画像/证据长期留存+应求删除；②分享链接不自动过期+应求撤销（均走异议 mailto）；③demo 每会话 3 次分析、TTL 24h——`DEMO_SESSION_TTL_MS` 默认 7 天改 `86400000`，demo.test.ts 断言改 24h；验证（Node v22.23.1）：API 150/150。法务意见仍待外部。
- 2026-09-21：**本机 embedded-PG「启动挂起」根因定位与修复（T1/T2，2 个英文原子提交，已随 PR #70 合入 main：`175acec` docs(handoff)、`cf43022` test(storage)）**——排查 `postgres-behavior.test.ts` 本机挂起，结论为**非确定性挂死、非项目代码缺陷**，两层：①**环境主因**——node_modules 的 better-sqlite3 被此前 Node v22 下的 install 编译为 NODE_MODULE_VERSION 127，切到权威 Node v24（`.nvmrc`=24.0.0，abi 137）后所有实例化 SQLite 的测试崩（一度 75 failed）；根目录 `pnpm rebuild better-sqlite3` 因子包依赖 selector 静默 no-op，改用 `pnpm rebuild -r better-sqlite3` 才真正重编译为 abi 137（仅动不入库的 node_modules）。②**测试健壮性次因**——embedded PG `initialise()`（initdb 冷启动）随机器负载波动，单文件实测 6–39s（initialise 峰值 14s），beforeAll 固定 60s 在全仓并发资源争用下偏紧，且 `onError` 被 `()=>{}` 吞掉、卡住时零日志；`cf43022` 把启动 hook 超时放宽到 120s、补 initialise/start/createDatabase 三阶段计时、onError 改为可见（CI 走 `DATABASE_TEST_URL` docker PG、不启 embedded，不受影响）。验证（Node v24.0.0，fnm）：storage 单包 14 文件 **115/115**（含真实 embedded PG 7/7）；包级串行 `pnpm -r --workspace-concurrency=1 test` **13 包 781 单测全绿**；默认全仓并发 `pnpm -r test` 在本机后台执行器下观测到一次 storage 进程被信号终止（日志戛然、无错误块，串行不复现），判为执行器资源/信号问题而非测试失败，以 CI（Linux runner + docker PG）为准。Windows 侧冷启动更慢（47.5s）但同样在 120s hook 内通过（见 §6）。
- 2026-09-20 及更早的变更流水（item35 形态 C 代码就绪、item34 部署加固、item33 Gitee OAuth 等）明细均已在 [handoff-archive-2026-09-20.md](handoff-archive-2026-09-20.md) §4–§8，本归档不重复。

## 9. Git 同步态（归档时点 2026-09-22）

- **远端（GitHub，实查）**：`origin/dev` = `2e906e8`（docs(handoff): record PR #70 merge into main）；`origin/main` = `81404a9` = **Merge pull request #71 from bayernjf/dev**（把 `2e906e8` 合入 main；PR #71 标题即「docs(handoff): record PR #70 merge into main」，2026-09-21 14:42 UTC MERGED）。PR #70（dev→main，18 提交）此前已合并（merge `0b243123`），无 open PR。
- **macOS 本地 `dev`**（2026-09-22 归档时点）：领先 `origin/dev` 的本地提交 = `3ddd18c`（item41 claim 英文化）、`78c86b3`（item41 handoff 回写）、`a2d949a`（item42 actionlint）、本批归档/验证 docs 提交（item43/44），**均未 push**（push 与 dev→main PR 由用户执行）。
- **跨设备丢失说明**：item42/43/44 于 2026-09-21 在 Windows 克隆创建为 `0a650d7`/`939768c`/`b145eb8`（当时临时编号 item41/42/43，本地 ahead 3、未 push）；随后用户在 Windows 执行 pull 后本地已与远端同步，那三个提交从本地丢失且**从未到达 GitHub**（GitHub 全量 refs 含全部 PR head 均查无、API 完整 hash 422、`git fetch <hash>` 返回 not our ref）。2026-09-22 在 macOS 侧按本归档编号重建，内容与验证数据完整保留（见 §5/§6）。
- 真实 OAuth 凭证只在 gitignored `.env`，`data/`、`.vercel/`、`dist/` 未跟踪，均不入库。
