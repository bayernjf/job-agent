# 候选人过滤下推 SQL（B1-b）· 设计

- 日期：2026-10-10
- 状态：设计（待触发条件满足后实施）
- 关联：`docs/design-b-side-full-loop-20261007.md`（B1-b 已修正为"过滤下推"而非"加分页"）、`docs/待推进路线图-20261009.md` L2-3、决策 #17（B 端）/ F10（招聘方声明闸）
- 本文只写设计，不重复记流水进度；实施进度记 handoff。

## 1. 现状与问题

人才检索（`/candidates`、`/candidates/export`）当前流程：

1. API 解析 `CandidateSearchQuerySchema` → `buildCandidateSearch(q)` 归一化 → 调 `repos.profiles.searchCandidates({ ...search, limit, offset })`（`apps/api/src/routes/recruiting.ts:122 / :147`）。
2. 仓储 `searchCandidates` **只做 `status='complete'` 粗筛**，然后 `.limit(CANDIDATE_SCAN_CAP)` 取最近 1000 条完整画像（`packages/storage/src/sqlite/profiles-repo.ts:16/121`、`packages/storage/src/postgres/profiles-repo.ts:16/116`）。
3. 全部精筛条件在内存中由纯函数 `searchCandidates`（`packages/storage/src/entities/candidate.ts:187`）完成：过滤（`evaluate`，109-157 行）→ 排序（`compare`，159-175 行）→ 分页（`offset/limit`，201-204 行）。

**问题**：`CANDIDATE_SCAN_CAP = 1000` 是"扫描窗"不是"结果上限"——一旦 `status='complete'` 画像超过 1000 条，**较早的画像永远不会进入候选集**，`total` 也不再是全量真实匹配数。翻页（`limit≤100` + `offset`）已在线，但突破规模只能靠把过滤下推回 SQL。

**当初为什么躲开**：SQLite JSON1 与 Postgres `jsonb` 的 JSON 查询方言差异大（`json_extract` vs `->`/`->>`/`jsonb_path_query`），且精筛条件是复合对象（`skills` 子串匹配、`keyword` 跨字段 AND、`authenticity` 嵌套字段），当时为一致性直接全量内存精筛。

## 2. 触发条件（先量再立项）

- **只有生产 `status='complete'` 画像数 > 1000 才实施本项**；不到则内存精筛正确且够用。
- 验证命令（需 DB 密码 / 会话串）：`SELECT count(*) FROM profiles WHERE status='complete';`
- 当前已知规模：演示预设 3 条，**未过闸**。本文先落设计，供过闸后直接执行。

## 3. 方案：条件归一化为 SQL 过滤表达式

原则：**先做确定性强的下推，模糊条件留内存兜底**，保证"下推结果 ⊇ 内存精筛结果"（SQL 只收紧扫描窗，不做最终判定），再在内存 `evaluate` 做最终过滤——结果与现状逐条一致，测试可对拍。

### 3.1 可下推字段（SQL 层粗过滤）

| 条件 | SQLite（JSON1） | Postgres（jsonb） | 语义 |
| --- | --- | --- | --- |
| `platform` | `json_extract(snapshot, '$.platform') = ?` | `snapshot->>'platform' = ?` | 精确等值 |
| `authenticity.status` | `json_extract(snapshot, '$.authenticity.status') IN (...)` | `snapshot#>>'{authenticity,status}' IN (...)` | 枚举集合 |
| `minConfidence` | `CAST(json_extract(snapshot, '$.authenticity.confidence') AS REAL) >= ?` | `(snapshot->'authenticity'->>'confidence')::float8 >= ?` | 数值下界 |
| `keyword`（login/displayName/headline 子串，词间 AND） | `(login LIKE ? OR json_extract(snapshot,'$.displayName') LIKE ? OR json_extract(snapshot,'$.headline') LIKE ?)`（每词一条，AND 连接） | 同构，`->>` | 每个词都必须命中任一字段 |
| `sortBy` 主键 | `updated_at` / 快照内字段同 `3.1` 的提取表达式 | 同构 | 排序下推（`recent` 用 `updated_at`，`skill_count_desc`/`confidence_desc` 用提取表达式） |

`skills` 过滤（`w.includes(h) || h.includes(w)` 双向子串）**不下推**——JSON 数组子串匹配在双方言都不可移植，且回填 `matchedSkills` 需要精确命中集。保持内存判定。

### 3.2 方言分支位置

- 分支只允许出现在 `packages/storage/src/{sqlite,postgres}/profiles-repo.ts` 各自实现内部（既有双实现模式，对齐 AGENTS.md「SQL 方言差异只允许出现在该模块内部」）。
- 仓储接口签名不变：`searchCandidates(query: CandidateSearchQuery): Promise<{ items; total }>`；API 无感。
- 内部实现：构造 `where` 条件 → 分页前先 `count`（同条件）得 `total` → `limit/offset` 下推 → 结果行过 `searchCandidatesPure`（内存 `evaluate` + `matchedSkills` 回填 + 排序）保最终一致性。

### 3.3 排序与分页

- 排序：SQL `ORDER BY` 先按下推键排（让 `limit` 取到的是"最近/最强"窗），内存再按 `compare` 终排；`total` 与排序无关（过滤后计数）。
- 分页：`limit/offset` 直接进 SQL（去掉了"先取 1000 再 slice"），翻页行为不变；`limit≤100` 单页上限保留。
- `removalRequestedAt` 软挂起过滤（`!row.removalRequestedAt`）下推为 `removal_requested_at IS NULL`（两侧同列名，无需 JSON）。

### 3.4 扫描窗上限的演进

- 下推后 `CANDIDATE_SCAN_CAP` 从"精筛窗"退化为"未下推条件的兜底扫描上限"，可保留一个更大的上限（如 10_000）防恶意全表扫描；或直接删除（有 `status` 索引 + 条件过滤后量级可控）。**倾向删除上限、保留 `status='complete'` 索引**，另配节流（见 §5 风险）。

## 4. 注入面与风险

- **一致性**：SQL 粗过滤只做"收紧扫描窗"，最终判定永远是内存 `evaluate`；测试用同一查询在"无下推（全量内存）"与"下推"两条路径上对拍，结果必须逐条相同（items + total + 顺序）。
- **方言漂移**：SQLite/PG 两侧表达式差异大，靠既有的双方言一致性测试 + `check-migrations.sh` 之外的**对拍测试**守护（本项不涉及迁移，但对拍用例必须两侧都跑）。
- **子串边界**：`keyword` 的 `LIKE '%w%'` 与内存 `h.includes(w)` 语义一致；`login` 是仓储列、`displayName/headline` 是快照内字段，提取表达式大小写处理需与 `normalize`（lowercase）一致——SQLite `LIKE` 默认 ASCII 大小写不敏感、PG 需 `LOWER()`，测试钉住。
- **节流**：过滤下推后扫描成本下降、可拉取范围变大，`/recruit` 翻页仍只有 F10 声明闸无节流——实施本项时**必须同时**给 `/candidates` 配节流（IP 滑窗 + 每日拉取上限，参照演示模式 IP 滑窗），否则一个自声明账号可用 `limit=100` 顺 `offset` 拉全量。该节流是独立面，列在待拍板清单。

## 5. 验收标准

1. 同一查询在"全量内存精筛（现状）"与"SQL 下推"两条路径对拍：`items` 逐条相等、`total` 相等、排序相等（测试夹具造 >1000 条 complete 画像跨过旧闸）。
2. `total` 在画像数 >1000 时仍等于真实匹配数（不再被扫描窗截断）。
3. `/candidates`、`/candidates/export` 行为无回归：过滤语义、翻页、F10 鉴权不变；CSV 导出行数 = 过滤后总数（受节流上界约束）。
4. SQLite 与 Postgres 双方言实现各自通过对拍测试（PG 侧 CI `postgres:16-alpine` service 实跑）。
5. 节流已配套上线（IP 滑窗 + 每日拉取上限）。

## 6. 实施步骤（过闸后按序执行）

1. 量生产 complete 画像数，>1000 则立项执行；否则归档本文等待。
2. 在 `entities/candidate.ts` 抽出"可下推条件 → 归一化表达式"的纯描述（不写 SQL），仓储两侧各自翻译成方言 SQL。
3. sqlite/postgres 各实现 `searchCandidates` 下推版 + 对拍测试（>1000 条夹具）。
4. API 侧无改动（接口不变）；补 `/candidates` 节流。
5. 全量门禁 + 文档回写（本文状态改"已实施"，handoff 登记）。
