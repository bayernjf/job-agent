# 提案：面试计划表（安排面试 + 追踪面试结果）

- 日期：2026-09-22
- 状态：**待拍板**（本文是 item45 的范围与数据模型决策草案，拍板前不写产品代码）
- 登记来源：handoff item45「面试计划表：可以安排面试和追踪面试结果」

## 1. 定位

面向**招聘方**的轻量面试协作：在一个候选人 × 一个岗位（即一条 application）上安排面试、记录状态流转、登记并追踪面试结果。

它与现有 `applications`（求职者侧投递漏斗，009）对称：applications 回答"我投到哪一步了"，面试计划表回答"这个候选人面试排得怎样、结论如何"。

## 2. 范围

### MVP 最小版（建议先做）

1. 从候选人/投递创建面试：选定时间（起止）、形式（onsite / phone / video）、轮次名称（如初筛、技术面、终面）
2. 面试官：自由文本姓名 + 可选邮箱（不引入多用户协作与权限）
3. 状态流转：`scheduled → completed / cancelled / no_show / rescheduled`
4. 结果记录：结论枚举（strong_yes / yes / neutral / no）+ 结构化反馈文本 + 评分（1–5，可选）
5. 列表视图：按时间/状态查看，候选人维度聚合"面试历史"
6. 状态变更与结果全程留时间戳

### 明确不做（留给后续）

- 多面试官账号协作、评价各自独立提交、权限/角色矩阵
- 日历双向集成（Google/Outlook）、自动邮件邀请与提醒
- 面试题库与评分表（scorecard）模板化、可配置轮次流水线
- 候选人自助约面（availability 双向选择）
- 与 ATS 的双向回写

## 3. 数据模型草案

新增一张表（双方言迁移，sqlite/postgres 文件名对齐）：

```text
interviews
  id              TEXT PK            -- int-<uuid>
  application_id  TEXT NOT NULL      -- 关联 applications.id（候选人×岗位）
  profile_id      TEXT NOT NULL      -- 冗余画像 id，便于候选人维度直查
  scheduled_start TEXT NOT NULL      -- UTC ISO8601
  scheduled_end   TEXT NOT NULL
  format          TEXT NOT NULL      -- onsite|phone|video
  round_label     TEXT NOT NULL      -- 自由文本：初筛/技术面/...
  interviewer_name  TEXT
  interviewer_email TEXT
  status          TEXT NOT NULL DEFAULT 'scheduled'
                    -- scheduled|completed|cancelled|no_show|rescheduled
  outcome         TEXT               -- strong_yes|yes|neutral|no（completed 后填）
  feedback_note   TEXT
  rating          INTEGER            -- 1..5，可空
  created_at / updated_at             -- UTC ISO8601
```

索引：`(application_id)`、`(profile_id, scheduled_start)`、`(status, scheduled_start)`。

不建新枚举表：枚举与 `applications` 一样以应用层常量 + Zod 校验守护。若后续要保留同一场面试的改期历史，再加 `interview_events`（append-only），MVP 用 `updated_at` + 覆盖即可。

与 applications 的衔接：安排第一场面试时，可将该 application 的漏斗状态推进为 `interview`（复用既有 status 枚举，零改动）。

## 4. 权限前提（需要拍板的关键点）

- 面试数据**绝不能匿名可见**，必须登录。现有账号主脊（accounts/auth_sessions，010/011）已能登录，但**没有"招聘方"角色概念**——当前登录用户即画像本人。
- 最小做法：不区分角色，任何登录用户都能管理自己创建的面试（以 `created_by_account_id` 行级归属）。这是个人效率工具，不是团队 ATS。
- 完整做法：引入 recruiter 角色 + 组织/团队实体，属于大改，不建议在本功能内引入。

## 5. 待拍板问题

1. **是否进入当前 MVP？** 建议**不进**：当前上线 MVP 的核心是"可信画像"，面试计划表是招聘方工作流延伸，且依赖尚未定义的招聘方角色；建议作为上线后的第一个迭代。
2. 角色：采纳第 4 节的"个人效率工具"最小做法，还是现在就规划团队/组织？
3. 范围：第 2 节 MVP 最小版是否就是首批范围？面试官是否需要可多选？
4. 结果是否需要多张评分表（每位面试官一份）？MVP 建议单一结果字段。
5. 入口放在哪：报告页 `/recruit` 招聘方视图内，还是独立页面？

## 6. 拍板后的落地顺序（预估）

1. shared 加 interview 类型 + Zod 契约
2. 迁移 012 双方言 + storage 仓储（IInterviewsRepository）
3. API：interviews CRUD + 状态/结果端点（登录闸，复用现有 user 身份）
4. 报告页招聘方视图加 React island（排期表单 + 列表 + 结果录入）
5. 单测 + 登录态 E2E
