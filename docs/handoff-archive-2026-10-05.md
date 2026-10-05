# handoff 历史归档（2026-10-05）

> 本文件为冻结只读历史归档，不再追加；现行状态见 [../handoff.md](../handoff.md)。

## 1. item128 决策 #23 逐条声明核验（批次 1 + 批次 2 全链明细）

### 1.1 批次 2：三个端点 + B/C 两端表面落地（2026-10-05 晚，接力会话完成）

**接手状态**：批次 1（内核 + 持久化）已落地；批次 2 的三个 API 端点其实已由前一会话写完但卡在收尾——`packages/storage/src/index.ts` 缺 claim 仓储/实体类型的 barrel 导出（API 已从 `@jobagent/storage` 引这些类型，缺导出会让 api typecheck/build 红）。接力会话先补这 7 行导出（`4ed6da0`）收口，再把批次 2 全部表面做完。

**交付面（设计 §6/§7/§8 全部兑现）**：

1. **证据水合（验收 §8.1）** `52bcb38`：核验投影原本只回证据 id（`matchedEvidenceRefs`），UI 无法点开原始记录。给 `formatClaimVerification` 增加可选 `evidenceById`，在 **POST/GET 同一道 `authorizeVerifier` 闸之后**把 id 水合成 `matchedEvidence:[{id,url,claim}]`；命中在该画像证据表里查不到的 id 一律跳过、不补造链接（no-fabrication）。文档 `c0d39a7`。
2. **报告页双表面** `c652d7c`：新 island `apps/report/src/components/ClaimVerifier.tsx`，一个组件挂两处——招聘方视图 `?view=recruiter`（`isRecruiter && canViewGated`，核验候选人）与求职者本人视图（新增 `isProfileOwner` 标志，投递前自检，把产品从"被核验"变"先自查"）。判定**只按 verdict code 渲染**（supportable/partial/no_trace/insufficient_data 四态徽章，绝不匹配英文句子），全部用户文案经 props 传入（zh/en key 对齐，i18n 一致性 22 绿），列表可建声明/撤回、证据可点；island 对 401/403 fail-closed 整体收起。挂载判据与 API `authorizeVerifier` 同口径（本人必须已认领；单源 platform+login、融合 'all' 按 login）。`lib/report-page.ts` 新增 `isProfileOwner`；样式全用 `--ja-*` token，**no_trace/insufficient_data 不用红色**（它们不是造假判定）。表面测试 7 条（列表+证据链接/空态/建/撤回/401/403/insufficient_data 不得出现 no_trace 文案）。
3. **/recruit 已核验条数（B 端列表第二处）**，三层原子提交：
   - storage `6889640`：仓储加 **`countByProfiles(ids) → Map<profileId,number>`**，刻意**只回数量不回声明原文**（保持 §6 窄泄漏面；原读口仅 listByProfile+getById），sqlite/postgres 双方言 groupBy 实现；`CandidateSummary` 加 `verifiedClaimCount`（纯投影默认 0）；+1 仓储测试。
   - api `259a351`：`GET /candidates` 在 requireRecruiter 闸后批量水合计数；+1 集成测试（回显 2 条且 JSON 不含声明原文）。
   - report `2822fb5`：`loadInitialCandidates` SSR 首屏同样水合，`CandidateWorkspace` 卡片页脚显示 `recruit.verifiedClaims`（zh/en）。

**验收 §8 五条逐条对账**：① 证据可点开——matchedEvidence 水合 + UI 链接 + smoke 实跑；② 反证"摘证据恒绿"——批次 1 claim-core 规则测试已钉（supportable 需 2 条真实存在证据、指向不存在 ref 不算数）；③ insufficient_data 真实夹具 + 文案不含"造假/没做过"——API 集成测试（抽象能力声明→insufficient_data）+ UI 测试钉"Not verifiable yet"出现而"No trace observed"不出现；④ 快照逐字节不变——真进程 smoke 实跑建/撤前后 `JSON.stringify(snapshot)` 全等；⑤ 真进程 smoke——构建产物 `apps/api/dist` + 一次性真实 SQLite 文件（迁移 CLI 跑到 029），FakeAuthProvider 登录招聘方→POST(supportable,2 链接)→GET(1)→DELETE(0)→anonymous GET 401，全部断言通过 `SMOKE PASS`，脚本/库跑完即删（在 /tmp，不入库）。

**验证（2026-10-05 21:37 实跑 `pnpm -r test`）**：全绿合计 **1405 passed**（16 包；storage 另 14 个 Postgres 行为测试本机无 DATABASE_TEST_URL 按 skip）——shared 108 / analyzer-core 89 / claim-core 10 / agent-core 33 / resume-core 56 / llm 42 / gitee-source 40 / github-source 27 / storage 209(+14 skip) / job-source 87 / worker 32 / cli 74 / api 290 / mcp 24 / report 173 / extension 111。`pnpm -r build` exit 0（含 Astro SSR 产物）、`bash tools/check-migrations.sh` 29 对双方言对齐 0 warning、pre-commit 全仓 typecheck 每个提交均过。

**本轮提交链（均在本地 dev，未 push，按约定由用户 push；pr-helper 随后自动 dev→main）**：
`91c2b2b` feat(api) expose endpoints（前一会话）→ `8bbc43b` docs(api) endpoints → `4ed6da0` feat(storage) barrel 导出 → `52bcb38` feat(api) 证据水合 → `c0d39a7` docs(api) 水合字段 → `c652d7c` feat(report) 报告页双表面 → `6889640` feat(storage) countByProfiles → `259a351` feat(api) candidates 计数 → `2822fb5` feat(report) /recruit 计数。接力会话起点本地领先 origin/dev 2 个提交，收口时领先 9 个。

**仍不做（边界不变）**：A 导入器（PDF/DOCX 抽取，决策 #9①，法务前置，永不进判定）；求职者隐藏核验结果（决策 #9④，待拍板，建议可隐自己的、不可隐招聘方对公开画像的核验）；未认领画像核验结果对 anonymous 公开（决策 #9②，首版只对本人+招聘方）；C 简历打分/ATS 排名；LLM 判定路径；把结果写回画像快照/进 /exportable/进 MCP。

---

### 1.2 批次 1：拍板 + 内核与持久化（前序会话，原文归档）

**决策 #23 逐条声明核验：拍板 + 批次 1（内核与持久化）落地（2026-10-05，`817689e` → `0e2a595` → `6570b8c` → `b18b855` → `4dde3bf`）**：**补齐产品最后一个结构性缺口——"改"这一步只有正向（画像→简历），没有反向（用户带来的简历逐条问"这句话 GitHub 痕迹支撑得起吗"）**，而「每条结论可复核」今天只覆盖我们生成的产物。用户拍板（已写入 [待拍板决策清单 #23](待拍板决策清单-20260910.md)）：**只做 B（结构化声明输入）**，A（PDF 抽取）降级为将来的预填导入器、**永不进入判定**，C 不做；初版**只对本人 + 已声明招聘方开放**（故设计 §6 原拟的"未认领画像对 anonymous 公开"首版不适用）；`no_trace` 措辞固定为「本工具未观察到对应痕迹」；隐藏功能本批不做。**批次 1 交付**：① `packages/shared` 新增**可核验技能词典**（`extractSkillTokens`，69 个技术词 + 别名，词边界 + 大小写不敏感 + 去重到 canonical）；② 新包 **`packages/claim-core`**（纯函数、无 I/O、`CLAIM_RULE_VERSION='0.1'` 与 `RULE_VERSION` 完全解耦）；③ 迁移 **029 `claim_verifications`** 双方言；④ storage 仓储接口 + sqlite/postgres 双实现 + 实体映射 + 工厂接线。**内核三条立身口径**（每条都有用例钉住）：`supportable` 需 **2 条真实存在的证据**（画像标签指向不存在的 ref 不算数）；**抽不出可核验 token 一律 `insufficient_data`，绝不判 `no_trace`**（"核验不了"与"没做过"是两句话，合并它们就是产品说谎）；`no_trace` 需"有可核验 token + **非空**证据列表且查无此物"（证据列表为空＝没查过，同样退回 `insufficient_data`）。另：**显式 artefact URL 直接命中**，但**孤立的 `PR #42` 不当显式指针**（无仓库信息就判定＝在别人仓库里碰运气撞同名数字）。**两个刻意的收敛面**：仓储**只给 `listByProfile` + `getById` 两个读口**（声明文本是第三方带来的隐私，宽查询口本身就是泄漏面）；**不提供通用 update**（结论与产出它的规则版本绑定，改判＝内核重算新行，不得就地 patch，否则同一 id 指向两套输出）；行上**不给 profiles 建外键**（本层只读画像、绝不回写、不参与级联）。**端点命名防撞**：设计稿原定 `/profiles/:id/claims` 与既有 `POST /profiles/:id/claim`（**认领**画像，`apps/api/src/routes/profiles.ts:127`）仅差一个复数 s，打错字会安静写进错的表，故改名 `/profiles/:id/claim-verifications`（与表名、包名同名同义）；**旧 `/claim` 端点不动**（已上线被报告页/扩展调用，改名是破坏性变更而收益相同）。**两次被守护抓到并修**（都修的是根因不是期望值）：① `migrations.test.ts` 的回滚用例把"最新迁移"硬编码 `028`，给它**加了 029 的回滚步骤**（顺带证明我写的 `DOWN` 块真能删表），而不是把断言改成 029；② **Dockerfile deps 阶段漏 COPY `packages/claim-core`**（与 item118 A11 同款坑：`pnpm install --frozen-lockfile` 不报错、后续 `COPY . .` 补回源码，故障只在镜像内且报错指不到根因）——补 COPY 后 `dockerfile-workspace` 守护 3/3。验证：`pnpm -r typecheck`/`build` exit 0、**`pnpm -r test` 全绿合计 1390（16 包）**——其中本轮新增 **+24**（claim-core 10 / storage +7 / shared +7）；**1390 与上文 1352 的差额不全是本轮**：1352 是 item112 当时的记录，未含 item122–127 新增的用例，本次一并刷新（过程见「最近变更」）、迁移校验 29 对双方言集合一致、schema-parity 16 + migrations-parity 19 + migrations 6 全绿、五条文档守护全绿、`git diff --check` 干净。**未做（批次 2 与之后）**：三个端点（`POST|GET /profiles/:id/claim-verifications`、`DELETE /claim-verifications/:id`）＋ 报告页 `?view=recruiter` 区块 / `/recruit` 已核验条数 / 工作台 C 端自检入口 ＋ 双语 ＋ 表面测试；A 导入器；隐藏功能；公开化。**鉴权零件不需要新建**：「已声明招聘方」＝决策 #17 一期 F10 的 `accounts.recruiter_declared_at`，端点复用现成的 `requireProfileOwner`（`apps/api/src/routes/helpers.ts:120`）与 `requireRecruiter`（`apps/api/src/routes/helpers.ts:139`）。**未 push**（本地 `dev` 领先 `origin/dev` 6 个提交，按约定由用户决定）。
