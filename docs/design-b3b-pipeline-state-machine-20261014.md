# 设计：B3-b 招聘方 pipeline 状态机（applications.stage + application_events）

- 日期：2026-10-14
- 状态：实施中（决策 #25 授权推进，仅 B3-b，B3-c/B2 组织模型不动）
- 前置：`docs/design-b-side-full-loop-20261007.md` §3 B3-b、§4 数据模型方向、§6 合规
- 对齐范式：`job_runs` CAS + `job_run_events` 只追加审计流（迁移 019/020、`compareAndSetStatusWithEvent`）

## 1. 背景与目标

决策 #25 拍板 B3-b「缓做」的理由是**成本性**（零用户的库加事件表不划算），不是硬触发条件；
本设计在该决策授权下推进 B3-b 最小子集，**不触碰** B3-c（多面试官，依赖 B2-b 组织模型）、
B2（teams/memberships 禁止预建）、B4（计费）。

目标（对齐 design-b-side-full-loop 验收）：
1. `applications` 有招聘方 pipeline 阶段（`stage`），候选人从投递到 offer 全程有**可回放**的状态流；
2. 状态迁移**原子条件更新**（CAS），并发推进不互相覆盖；
3. 事件流**只追加、不回改、不删除**（对齐 job_run_events 惯例）；
4. 候选人可见"到哪一步"（MVP 默认可见，开关留后续批次）。

## 2. 语义定义：stage 与 status 并存

| 维度 | 现有 `status`（7 值） | 新增 `stage`（6 值 + null） |
| --- | --- | --- |
| 视角 | 求职者侧漏斗状态（saved/applied/viewed/interview/offer/rejected/withdrawn） | 招聘方 pipeline 阶段（new/screening/interview/offer/hired/rejected） |
| 维护者 | 候选人本人（认领画像主体） | 岗位归属招聘方（F10 声明闸） |
| 作用域 | 任意投递记录 | **仅关联到招聘方自建岗位的投递** |
| 是否必填 | 必填（默认 applied） | **可空**：null = 不在任何招聘方 pipeline（历史行、手动投递、聚合岗位投递） |

两列并存、互不覆盖：候选人看自己的漏斗，招聘方推进自己的 pipeline。
`status` 的写入契约（`ApplicationPatchSchema`、仓储 `update` 行级归属）一律不动。

## 3. 状态机与迁移合法性

阶段枚举（值域由 shared 的 `APPLICATION_STAGES` 拥有；迁移表不加 CHECK，对齐 job_run_events）：

```
new → screening → interview → offer → hired
        ↘              ↘           ↘
         rejected       rejected    rejected
```

合法迁移集（`APPLICATION_STAGE_TRANSITIONS`，shared 导出）：

| from \ to | new | screening | interview | offer | hired | rejected |
|---|---|---|---|---|---|---|
| null（首次推进） | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| new | – | ✅ | – | – | – | ✅ |
| screening | – | – | ✅ | – | – | ✅ |
| interview | – | – | – | ✅ | – | ✅ |
| offer | – | – | – | – | ✅ | ✅ |
| hired / rejected | – | – | – | – | – | –（终态） |

规则：
- `null → 任意阶段`：招聘方首次推进直接落当前位置（第一次就可以标 screening/interview/offer/终态）；
- 非 null 时仅允许上表迁移；**非法迁移 400**（明确错误码 + 当前/目标阶段）；
- **单向、不回退**；`hired`/`rejected` 为终态。误操作不提供回退端点（MVP 不做"复活"），
  由 payload `note` 留痕，事件流可回放——未来若需要复活语义，加迁移 `rejected → new` 走事件即可，不回改历史。
- 并发：仓储 CAS 用 `expectStage`（调用方从当前行读出），CAS 输家返回 undefined，API 回 **409**（提示重读重试），事件零写入。

## 4. 数据模型（迁移 039，双方言）

```sql
-- applications 加 stage（可空，无 CHECK；值域由 shared 拥有）
ALTER TABLE applications ADD COLUMN stage TEXT;

CREATE TABLE application_events (
  id          TEXT PRIMARY KEY,            -- evt-<uuid>
  application_id TEXT NOT NULL,            -- applications.id
  event       TEXT NOT NULL,               -- stage_change（本期唯一 kind，预留扩展）
  from_stage  TEXT,                        -- null = 首次推进
  to_stage    TEXT NOT NULL,
  actor       TEXT NOT NULL,               -- user|recruiter|system
  payload     TEXT NOT NULL DEFAULT '{}',  -- JSON：{ note?, postingId }
  created_at  TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);
CREATE INDEX idx_app_evt_application ON application_events (application_id, created_at);
```

- 无外键（对齐 job_run_events：级联删除应用侧处理——`deleteByProfile` 需同步清事件）；
- drizzle schema 双方言注册新列与新表。

## 5. 仓储契约扩展（IApplicationsRepository）

```ts
/** B3-b：CAS 推进 stage；expectStage=null 表示首次推进；事件与推进同事务；
 *  非法迁移由调用方（API 层）依据共享迁移表预校验，仓储不重复判合法 */
advanceStage(
  id: string,
  expectStage: ApplicationStage | null,
  toStage: ApplicationStage,
  event: NewApplicationEvent,
): Promise<StoredApplication | undefined>;

/** 阶段事件流（只追加审计，created_at 正序回放） */
listStageEvents(applicationId: string): Promise<StoredApplicationEvent[]>;

/** 扩展 deleteByProfile：同事务删除该画像投递的阶段事件 */
```

实体新增（`entities/application.ts` 或新文件）：
- `ApplicationStage` 类型 + `APPLICATION_STAGES` + `APPLICATION_STAGE_TRANSITIONS`
- `StoredApplication.stage: ApplicationStage | null`
- `NewApplicationEvent` / `StoredApplicationEvent`（对齐 `NewJobRunEvent` 形状）

## 6. API 端点

| 端点 | 鉴权 | 说明 |
| --- | --- | --- |
| `PATCH /applications/:id/stage` | F10 声明闸 + 岗位归属校验 | body `{ toStage, note? }`；投递必须关联到**当前招聘方自建**岗位（`job_postings.created_by_account_id = principal.accountId`），否则 404 不泄露存在性；非法迁移 400；CAS 输家 409；成功返回更新后的投递（含 stage） |
| `GET /applications/:id/events` | 候选人主体闸 **或** 岗位归属招聘方 | 返回 `{ items }`（正序事件流）——满足"候选人可见到哪一步" |
| `GET /job-postings/recruiter/:id/applications` | F10 声明闸 + 岗位归属校验 | 招聘方看自己岗位的投递列表（profile 摘要 + status + stage），UI 数据源 |

- `PATCH /applications/:id`（现有）不改：status/note/outcomeFeedback 契约原样；
- `POST /interviews` 的"早期推进 status→interview"逻辑不改（stage 是独立维度，MVP 不做自动联动）。

## 7. UI 增量（最小）

1. **RecruiterPostings.tsx**（招聘方岗位面板）：岗位卡新增「投递」折叠区——列出该岗位投递
   （候选人摘要 + stage 徽标 + 下一阶段推进按钮，非法下一步隐藏）；数据源
   `GET /job-postings/recruiter/:id/applications`，推进 `PATCH /applications/:id/stage`。
2. **ApplicationTracker.tsx**（候选人投递区）：stage 非空时显示 pipeline 徽标（new→…→hired/rejected），
   只读展示，不提供操作。

## 8. 合规 / 隐私边界

- 推进只允许岗位归属招聘方（私有 pipeline 不跨主体，对齐"非本人资源 404"约定）；
- 事件流只追加；`actor` 区分 recruiter/user/system，回放可审计；
- 候选人侧可见性 MVP 默认开；"可选开关"（招聘方关掉某岗位投递对候选人可见性）留后续批次，
  本期不建配置表；
- 不触碰：招聘方代传简历、全自动筛选决策、teams 预建、计费。

## 9. 测试计划

- storage：双方言——`advanceStage` CAS 成功/输家（零事件）、首次推进（null→stage）、事件同事务、
  `listStageEvents` 正序、`deleteByProfile` 级联清事件；
- api：PATCH stage（匿名 401 / 未声明 403 / 非归属 404 / 非法迁移 400 / CAS 冲突 409 / 成功 200）、
  GET events（候选人主体 200、岗位归属招聘方 200、他人 404）、GET postings applications（归属校验）；
- E2E：招聘方自建 JD → 候选人投递 → 招聘方推进 new→screening→interview→offer→hired → 事件流回放一致。

## 10. 验证与交付

- `check-migrations`（双方言从 0 重放）→ `typecheck` → `test` → `build` → E2E 全绿；
- `docs/API.md` 同步新端点 + `Application` 字段；
- 本设计文档 + `handoff.md` 登记；
- 提交按仓库惯例（shared → storage → api → report 原子提交），pr-helper 自动合并 dev→main。
