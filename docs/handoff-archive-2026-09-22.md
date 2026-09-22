# handoff 归档 · 2026-09-22

> 本文件**冻结只读、不再追加**。收录 2026-09-22 扩展真机验证批次（handoff item46，任务 #52–#57）的完整明细、commit 链、验证数据，以及当日从 handoff 主文件「最近变更」区裁出的 2026-09-21 两条流水。主文件只留一行结论 + commit hash。
>
> 上一份归档：[handoff-archive-2026-09-21.md](handoff-archive-2026-09-21.md)。

---

## 1. item46：扩展真实 ATS 页面一键填充冒烟 + 跨端同步真机验证（任务 #52/#53）

在用户日常 Chrome（固定 pid，加载 unpacked 扩展 `apps/extension/dist`，固定扩展 ID `dgbnkdljapgglpdcmncbleioocbjfmmc`）中导航**真实 Greenhouse 岗位页**完成端到端真机验证，目标页：

- Discord「Staff Software Engineer - Consumer Revenue」：`https://job-boards.greenhouse.io/discord/jobs/8464570002`（jobId `8464570002`，匹配 low 8）。日常 Chrome 经本机代理 `127.0.0.1:7897` 访问 Greenhouse 实测 200。

真机验证串联起四个此前未在真实 HTTPS ATS 页暴露的缺陷（#54–#57，见 §2–§5），全部闭环后逐项复测通过。

**跨端同步权威结论（#53）**：Greenhouse HTTPS 域 content script 面板的 Local details 正确显示报告页 ResumeBuilder 推送的 Email / Phone / Location（经 `chrome.storage` + `externally_connectable` 消息桥），证明报告页 → 扩展的跨端通道在真实第三方 HTTPS 域工作。

**测试数据（非真实隐私）**：email `linus.test@example.com`、phone `+1-555-0100-2026`、location `Portland, OR (smoke-test)`、personalSite `https://example.com/~linus-smoke`、fullName 留空。

> 真机操作铁律：改 `src` 后必须在 `apps/extension` 跑 `node build.mjs` 重建 dist → `chrome://extensions/` 点 JobAgent 卡片自己的「重新加载」→ 刷新 ATS 标签页（host_permissions 变更尤其必须）。表单填好后**绝不点 Submit**，不真实投递申请。

---

## 2. #54：content script 直连 API 在 HTTPS ATS 页必失败 → 改走 background service worker 代发

### 根因（真机 + curl 复现）

修复前 content script 直接 `fetch('http://localhost:3000/...')`。在真实 `https://job-boards.greenhouse.io` 页面上，浏览器因 **CORS / 混合内容（HTTPS 页请求 http://localhost）/ 私有网络访问（PNA）** 限制直接拦截，请求 `status=0`、面板报 `Failed to fetch`，根本到不了应用层。

- 真机在面板触发后用 curl 复现应用层真实响应：无 cookie 时 `POST /analyze` body `{username, platform}` 返回 **403 `DEMO_REQUIRED`**；字段名必须是 `username`，发 `login` 报 400。
- 即：传输层在页面源就被浏览器掐断，与后端逻辑无关。

### 修复（commit `69d8bc8`）

- 新增 `apps/extension/src/lib/sw-relay.ts`：消息常量 `EXT_MSG_API_REQUEST='jobagent.apiRequest'` + 纯函数 `relayApiRequest`（注入 fetch，便于单测），在**扩展源（background service worker）**执行请求，异常收敛为 `status=0`。
- 新增 `apps/extension/src/lib/sw-fetch.ts`：content 侧与 `fetch` 同形的适配器，经 `chrome.runtime.sendMessage` 把 method/headers/body（结构化克隆）转发给 SW，返回 Response-like（`ok/status/statusText/json()/text()`）；SW 不可用或网络失败抛 `TypeError`，与原生 fetch 失败行为一致。`JobAgentApi` / `matchJobs` 无需感知传输通道，单测仍注入假 fetch。
- `background/index.ts` 加内部 `onMessage` 调 `relayApiRequest`（保留 `onMessageExternal` 跨端桥）。
- `content/panel.tsx` 的 `handleAnalyze`、`loadMatches` 改用 `swFetch`。
- `manifest.json` `host_permissions` 追加 `http://localhost:3000`、`http://127.0.0.1:3000`、`https://job-agent.bayjf.com`（生产占位，见 §7）。
- 单测：`sw-relay.test.ts` 9 例、`sw-fetch.test.ts` 6 例。

---

## 3. #55：画像快照过 24h TTL 后匿名扩展无法解析（403 DEMO_REQUIRED）→ 公开只读 by-subject 端点

### 根因（源码 + 真机）

`apps/api` `POST /analyze` 的缓存命中要求 `latestBySubject` 存在 + `complete` + `Date.now()-updatedAt < PROFILE_CACHE_TTL_MS`（默认 24h），且命中判断在权限闸之前。超 TTL 的快照会走「触发新分析」分支 → 匿名用户被演示闸挡 **403 `DEMO_REQUIRED`**。但画像快照本就**永久存在、`GET /profiles/:id` 公开**，分享链接不设 TTL；「加载一份已生成的画像来一键填充」不应被 24h 缓存 TTL 与演示配额挡住。真机复现：本地库 `torvalds` 画像（profileId `0d83a702-3f75-4a1e-aad5-3fea0fd46ca7`，github，complete，`updated_at 2026-09-15 14:48:56`，已超 24h）在旧扩展匿名加载即 403。

### 修复 — 后端（commit `acd27bd`）

新增公开只读端点 **`GET /profiles/by-subject/:platform/:login`**：

- 注册顺序在 `GET /jobs/:id` 之后、`GET /profiles/:id` **之前**（避免被 `:id` 吞掉）；内联 `SubjectLookupParamSchema` 校验 platform/login。
- 存在 `complete` 快照时**只回指针** `{profileId, status:'complete', cached:true, analyzerVersion, updatedAt}`——不看 TTL、不扣配额、不触发分析、任何身份放行、不返回 snapshot body（不暴露超出公开 `exportable` 的数据）。
- 无 complete 快照（含/不含 partial）回 **404 `PROFILE_NOT_FOUND`**；platform/login 非法回 400。
- 单测 `apps/api/src/index.test.ts` 新增 7 用例（complete github 匿名 200 只回指针无 snapshot/skills 且不建 job、gitee 200、跨平台同 login 不匹配 404、无快照 404、partial 404、platform=all 400、非法 login 400）。

### 修复 — 扩展客户端（commit `b32a588`）

`apps/extension/src/lib/api.ts` `fetchProfile`：

- 单源（github/gitee）先私有 `resolveBySubject` 调 by-subject：**200** 取 `profileId` 直接 `GET /profiles/:id/exportable`，跳过 `POST /analyze` 与轮询；**404** 回退 `POST /analyze`（触发新分析，受演示配额约束）；**其他非 2xx** 抛 `profile lookup failed (HTTP n)`，**不静默回退**。
- `platform=all` 无单一主体快照，直达 `POST /analyze`。
- `api.test.ts` 整文件重写为 8 用例（by-subject 命中不 POST、404 回退 POST 缓存命中、all 直达不 lookup、404 后轮询、404 后 job failed、非 404 错误不回退、lookup 400 校验失败、命中后 exportable schema 坏抛错）+ matchJobs。

### 真机复测（通过）

全新加载 Greenhouse 页、输入 `torvalds` 点 Load：新扩展经 SW 代发调 by-subject 成功，显示 **Linus Torvalds / Likely authentic (82%) / 13 技能 / Job matches(5)**，无 403、无 demo 报错。证明「看已有画像不受 24h TTL / 演示闸限制」。

### 设计取舍（新增公开 API 面）

by-subject 符合「看已有画像不受限」精神、数据本就公开，但属新增公开端点。已刻意：只回 profileId 指针、复用现有 `exportable` 投影、不暴露新数据、不看 TTL、不扣配额、不触发分析。

---

## 4. #56：Greenhouse 城市 Location 被误填进电话分组的 Country/区号框

### 根因

`ats/greenhouse.ts` 原 `set(['country','location'], location)`；`findFields` 子串匹配按 DOM 序取第一个命中。电话组的区号 ComboBox（aria-label 含 `Country`，DOM 更靠前）与独立 Location(City) 框都命中 `country`/`location` 关键词，导致城市串被写进电话区号框。

### 修复（commit `18f7d8e`）

- ATS 内核 `findFields` 加第三参 `exclude:string[]=[]`（归一化后做排除词判定：命中关键词且不在排除集合）。
- Greenhouse/Lever：phone 透传排除 `country/dial/area`；location 删除 `country` 关键词并排除 `phone/country/dial/area code`；github 输入排除 `linkedin/website/portfolio`。
- `workday.ts` 未改（仍是骨架）。

---

## 5. #57：Website / personalSite 未填充

### 根因

ATS `FillValue` 联合类型与 `LocalAtsFieldsSchema` 都没有 website/personalSite 槽位，Website 框永远不会被填。

### 修复（commit `18f7d8e`，shared 契约与 ATS 适配器同提交以保证可编译）

- `packages/shared/src/index.ts`：`LocalAtsFieldsSchema` 在 `linkedinUrl` 后加 `personalWebsite: z.string().url().optional()`；`localProfileToAtsFields` 加 `personalSite → personalWebsite` 投影；`legacyAtsToLocalProfile` 加反向投影。`local-profile.test.ts` 补投影与往返用例。
- ATS 内核：`FillValue` 联合加 `'personal_website_url'`；`toFillValues` 加 personalWebsite 投影。
- Greenhouse 新增 `website = set(['website','portfolio'], personal_website_url, ['linkedin','github'])`；Lever 新增 `website = set(['website','portfolio','blog','personal site'], personal_website_url, ['linkedin','github'])`。
- `ats.test.ts` 新增「greenhouse standard field disambiguation (#56/#57)」两例（区号框保持空 + City 落 Portland；Website 填 personalWebsite 且不撞 LinkedIn/GitHub）。

### 真机复测（#56/#57 一次 Fill 同时闭环）

点 Fill the form 后 AX 树逐字段核对，**Filled 7 fields**：

| 字段 | 值 | 说明 |
|---|---|---|
| First name | Linus | |
| Last name | Torvalds | |
| Email | linus.test@example.com | |
| Phone（分组 247） | +155501002026 | 去格式 |
| Location City ComboBox（255） | Portland, OR (smoke-test) | #56 |
| 电话组 Country/区号 ComboBox（236） | 仅剩默认 `+1` 占位，**无城市串** | #56 修复确认 |
| Website（360） | https://example.com/~linus-smoke | #57；该 personalSite 由报告页 ResumeBuilder 推送、持久化在扩展 chrome.storage 本地档案 |
| LinkedIn（355） | 空 | 本地未填，符合预期 |
| Why Discord textarea（350） | torvalds 画像 summary | summary→自定义问题 |
| EEO / Gender / Race / 授权 / 薪资 / How did you hear | 全部正确留空 | 刻意不写 |

**未点 Submit（527）**。

---

## 6. 扩展浏览器级 E2E：补 by-subject 链路 + 稳定化（10/10）

`#55` 给扩展加了 by-subject 前置请求后，浏览器级 E2E（`pnpm e2e:extension`，Playwright `--headless=new` 加载 unpacked MV3、零网络 context 路由）首次重跑暴露**测试夹具缺口**（非产品缺陷）：

- fixture `e2e/extension/extension-test.ts` 原本只 context 级拦截 `**/analyze`、`**/profiles/*/exportable`、`**/job-postings/match`、ATS 页，**没有 by-subject 路由**。单源加载先 GET by-subject 在零网络环境落空为非 404 错误 → 客户端不回退 → 6 个单源加载用例 `.ja-result` 超时；只有不加载画像的 2 例与不走 by-subject 的 fused（platform=all）1 例通过（恰为 3 passed / 6 failed）。
- **修复**：fixture 加 `**/profiles/by-subject/**` 默认 **404**（回退 /analyze 缓存短路，最贴近新用户路径）；`match-panel.spec.ts` 新增用例「cached snapshot resolution by subject (#55)」（用例级 context.route 覆盖为 200 指针，断言 `.ja-result` 出现、`lastAnalyzeBody()` 为 `null` 即未触发 /analyze、match list 3 条；Playwright 后注册路由先匹配）。
- **稳定化**：`playwright.extension.config.ts` 单测 `timeout` 30s → **60s**。headless=new 冷启动 + 解压加载 unpacked MV3 在前几个用例较重，机器并行跑日常 Chrome 时 fixture `_harness` setup 偶发超 30s（断言超时 expect 7s 不变）。
- #54 同期 E2E 适配：`/analyze` 由 page 级改 **context 级**路由（SW 发出的请求 page 级拦不到），记录请求体 `lastAnalyzeBody`，新增 GitHub/Gitee/Fused 平台切换两用例。

**最终结果：10 passed（约 2.0m）**。

### 本批静态门禁（Node v24.0.0 / fnm，实跑全绿）

- `pnpm -r typecheck` 0 error；`bash tools/check-migrations.sh` 11 对 0 warning；`git diff --check` 干净。
- 包级单测：`apps/api` **157 passed**（13 文件，含 by-subject 7 例）、shared / extension 单测通过。
- `pnpm -r build` 全 Done；扩展 dist 重建 `content.js 311.9kb` / `background.js 69.1kb`（api base `http://localhost:3000`）。
- 扩展浏览器 E2E **10/10**。
- 本机 macOS 26 下 embedded-postgres 18.1.0-beta.15 内置 PG 二进制启动 FATAL（postmaster multithreaded 误报）仅影响本机 storage 真 PG 测试，CI Docker PG / Windows 不受影响（见 2026-09-22 评审 §五），故本批未跑 storage 全包。

---

## 7. 未决产品 / 外部项（本批发现，未擅自扩范围）

1. **两端本地档案字段不对称**：报告页 ResumeBuilder 表单有 fullName/email/phone/location/**personalSite**（**无 linkedinUrl**）；扩展面板 Local details 有 email/phone/location/**linkedin**（**无 personalSite**）。于是 LinkedIn 只能在面板补、personalSite 只能在报告页补（#57 真机的 Website 值即来自报告页推送、面板无输入框）。是否两端对齐（报告页补 LinkedIn、面板补 personalSite）待拍板。
2. **生产占位域**：`manifest.json` 的 `host_permissions` 与 `externally_connectable` 白名单仍含占位 `https://job-agent.bayjf.com/*`，形态 C 确定真实 API/报告页域后必须改域并重建 dist（deferred「生产报告页域名与扩展白名单」在册）。`optional_host_permissions` 运行时扩域未做，可入 deferred。
3. **Workday 端到端仍待验证**：未改 workday 适配器（骨架），待找到直渲染 `data-automation-id` 表单且 API 可访问的真实租户页（触发条件沿用既有已知限制）。
4. 真实 CWS 上架、生产 API 构建重截（去 localhost 占位）、真人试用仍为外部项。

---

## 8. commit 链（本批，dev，均未 push；无 AI co-author）

| commit | type(scope) | 内容 |
|---|---|---|
| `acd27bd` | feat(api) | add by-subject profile lookup endpoint（#55 后端，7 单测） |
| `69d8bc8` | feat(extension) | proxy API through service worker（#54 传输层 + SW 单测 + #54 E2E 适配 + E2E timeout） |
| `b32a588` | feat(extension) | load cached snapshot by subject（#55 客户端 + by-subject E2E 用例） |
| `18f7d8e` | fix(extension) | disambiguate location/phone, fill website（#56/#57 + shared 契约） |
| （docs 提交） | docs | handoff 回写 + 本归档 + docs/README + INSTALL（hash 见 handoff Git 状态） |

原子拆分说明：#54 与 #55 在同一测试文件相邻，为保证**每个提交自身 E2E 也绿**，E2E 用「仅 #54 中间版 → 提交 → 恢复 #55 最终版 → 提交」拆分：`69d8bc8` 时点客户端仍是旧的直连 POST /analyze（经 SW），配合 context 级 /analyze 路由与平台用例；`b32a588` 再引入 by-subject 前置与 404 路由 / 命中用例。

---

## 9. 当时 Git 同步态（2026-09-22）

- 分支 `dev`（track `origin/dev`）。本批前 `origin/dev` = `2e906e8`、`origin/main` = `81404a9`（PR #71 合并），无 open PR。
- 本批 4 个代码提交 + 1 个 docs 提交在本地领先 `origin/dev`（push 与 dev→main PR 由用户执行）。
- 真机用本地库 `data/job-agent.db`（SQLite）：6 条 complete 画像、2303 条 job_postings、0 applications；`.env` 无 GITHUB_TOKEN（worker 不启动，画像走缓存/by-subject）。
- 本地起 API 姿势：`export DB_PATH=/Users/jiangfeng/000mycodes/job-agent/data/job-agent.db`（绝对路径）+ `pnpm --filter @jobagent/api dev`（dev 跑 dist，改 api 源码需先 build api 包）；报告页 `pnpm --filter @jobagent/report dev`（:4321）。本批临时 dev 服务用完已停。

---

## 10. 从 handoff 主文件「最近变更」裁出的 2026-09-21 流水

> 主文件「最近变更」只保留最近 5 条，以下两条 2026-09-21 流水于 2026-09-22 裁出，原文收录于此（09-21 归档已冻结、不再追加）。

### 10.1 权威 Node v24 完整验证基线补齐 + native addon 铁律固化

2026-09-21（本地英文原子提交，未 push：`049ea1a` docs(build)、当日 handoff）：此前 Node24 只复跑了单测，报告/扩展 E2E 仍沿用 Node v22 基线；本轮在 Node v24.0.0（fnm，better-sqlite3 abi 137）下重跑：报告 Playwright E2E **52/52（约 1.9m，webServer 自动起 Astro + fixture SQLite）**、扩展 E2E **9/9（约 30.5s，先 build MV3、`--headless=new` 零网络）**，结合包级串行单测 **13 包 781 全绿**与 storage 真实 embedded PG 7/7，Node24 全链路基线闭环；actionlint（Docker `rhysd/actionlint`）全量扫 ci.yml/jobs-sync.yml exit 0。另把环境教训写入 AGENTS.md：fnm/nvm 切 Node 版本后必须 `pnpm rebuild -r better-sqlite3`（根目录不带 `-r` 因子包依赖 selector 不匹配会静默 no-op），否则 native addon 仍按旧 `NODE_MODULE_VERSION` 编译、SQLite 测试集体崩；CI 在 Linux 全新 install 不受影响。

### 10.2 修复 main 上 Jobs sync 定时任务在形态 C 部署前每晚刷红

2026-09-21（`cc9de52` ci(sync)，本地提交未 push）：PR #69 自动并入 main 后「合并后验证」1/2 失败——main 的 `Jobs sync` schedule run（[35536757602](https://github.com/bayernjf/job-agent/actions/runs/35536757602)，每日 18:17 UTC）跑 CLI 时因仓库未配 `DATABASE_URL` secret（形态 C Supabase 尚未部署）触发 `packages/storage/src/storage.ts:59` fail-fast（`DB_DRIVER=postgres requires DATABASE_URL`）exit 1。修复 `.github/workflows/jobs-sync.yml`：新增 `Guard DATABASE_URL secret`（`id: guard`，输出 `has_db`）——**schedule 触发且缺 secret 时打 `::warning::` 并令 has_db=false，install/build/两个 sync 步骤全部 skipped、run 整体成功；workflow_dispatch 手动触发缺 secret 仍硬失败；secret 存在则正常执行**；CLI fail-fast 保留为最后防线。guard shell 四组合（schedule/dispatch × 有/无 secret）断言全过，actionlint exit 0。注意 GitHub `schedule` 仅在默认分支 main 运行：本修复须经下一个 dev→main PR 合入 main 后下一次 cron 才转为中性跳过；合入前若到点旧版仍会再红一次。
