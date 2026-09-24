# Privacy Policy / 隐私政策

> Status: **Current**, 2026-09-24. This is the canonical bilingual source for the
> JobAgent privacy policy. The user-facing pages live at `/en/privacy` and
> `/zh-CN/privacy` on the report site (Form C deployment); keep both in sync when
> this document changes. The Chrome Web Store listing links to the hosted page.
>
> 状态：**现行**，2026-09-24。本文件是 JobAgent 隐私政策的中英双语权威源；
> 用户可见页面部署在报告站 `/en/privacy` 与 `/zh-CN/privacy`（形态 C），
> Chrome Web Store 上架材料链接到托管页面。修改本文件时同步修改页面。
>
> Contact / 联系方式：**dispute@job-agent.bayjf.com** (overridable at deploy time
> via `PUBLIC_DISPUTE_EMAIL`; the mailbox must be monitored before launch).

---

## English

### JobAgent Privacy Policy

_Last updated: 2026-09-24_

This policy covers the JobAgent web service (the ability-report site and its API)
and the **JobAgent Autofill** browser extension (collectively, "JobAgent", "we",
"us"). JobAgent analyzes **public** developer activity on GitHub and Gitee to
produce evidence-backed ability profiles, matches profiles to job postings, and
helps fill out application forms on supported applicant tracking systems (ATS).

We design JobAgent to collect as little personal data as possible.

#### 1. Information we process

**1.1 Public code-platform data (core feature).**
When you submit a GitHub or Gitee username, we call the platform's official API
to read **public** information only: the public profile, public repositories, and
public commits, pull requests and issues. We never clone repositories, never
request access to private repositories, and never ask for your code-platform
password. This data is processed into an ability profile whose every conclusion
links back to the public evidence.

**1.2 Sign-in data (only if you choose to log in).**
You can use the core report without an account. If you sign in with GitHub or
Gitee OAuth to claim a profile, we receive your public username/display name and,
where the platform provides it, an email address (GitHub: the `user:email` grant,
which may be empty; Gitee: the `user_info` grant). We store an account record so
you can claim the profile that belongs to you. Your email is never returned by
the "who am I" API endpoint and is never shown to other users.

**1.3 Technical data for anonymous demo rate limiting.**
Anonymous ("try the demo") usage is rate limited. To enforce this without storing
your IP address, we store only a **salted SHA-256 hash** of your IP address
together with an opaque session identifier and timestamps. We cannot reconstruct
your IP from the hash. Rate-limit records expire automatically (demo sessions
live 24 hours).

**1.4 Contact details you enter — kept on your device, never uploaded.**
The name, email, phone number, LinkedIn URL, location and personal website you
type into the extension panel or the report-site resume form are stored **only in
your browser's local storage**. They are not transmitted to or persisted on our
servers. They are written only into the application form you are viewing, and
only when you click the fill/apply action yourself. You can erase them at any
time by clearing the extension's local data (or your browser's site data).

**1.5 Resumes you generate.**
Targeted resumes are assembled in your browser / on your own machine from your
profile and the job posting. We do not store resume documents or your local
profile fields on the server. If an optional AI-polish provider is configured by
the operator, polishing requests are sent to that operator-configured
OpenAI-compatible endpoint; AI polish is **off by default** and the feature falls
back to rule-based output when it is not configured.

**1.6 Strictly necessary cookies and client storage.**
After OAuth sign-in we set an HTTP-only session cookie so you stay signed in.
The extension uses Chrome's `storage` permission for the on-device contact
details described in 1.4. We do not use advertising or cross-site tracking
cookies.

#### 2. Information we do NOT collect

- Your GitHub, Gitee or ATS passwords — the extension never sees or types a
  password field, and OAuth never asks for one.
- Private repositories, private issues, or any non-public code-platform data.
- Payment or billing information.
- Browsing history outside the supported career/job pages; the extension activates
  only on Greenhouse, Lever, Workday and pages whose URL contains `careers` or
  `jobs`.
- Salary, demographic (EEO), visa-authorization or similar sensitive ATS fields —
  the autofill deliberately leaves these blank for you to complete.

#### 3. How we use information

- To generate, store and display evidence-backed ability profiles and shareable
  report pages.
- To match profiles with aggregated public job postings and to prefill supported
  application forms.
- To authenticate sign-in and profile claims.
- To prevent abuse of the anonymous demo quota.
- To operate, secure and debug the service (server logs of the hosting platform).

We do not sell personal data, and we do not use it for advertising.

#### 4. Sharing and subprocessors

We share data only with the infrastructure providers needed to run JobAgent:

| Subprocessor | Purpose | Data potentially exposed |
| --- | --- | --- |
| Vercel (hosting, region Tokyo) | Web service, API and scheduled functions | Request metadata, IP (for the salted hash), service data |
| Supabase / PostgreSQL (region Tokyo) | Primary database | Profiles, evidence, accounts, sessions, rate-limit hashes |
| GitHub / Gitee official APIs | Source of public developer data | The username you submit; public data returned |
| Operator-configured LLM endpoint (optional, off by default) | Resume text polishing | Resume text you choose to polish |

When you click through to a job posting or submit an application, you leave
JobAgent and interact directly with that third-party ATS, whose own privacy policy
applies.

#### 5. Data retention and deletion

- Ability profiles and their evidence are retained long-term so that shared report
  links remain stable and verifiable (decision #14).
- Share links do not expire automatically.
- **On request we will delete a profile/evidence and revoke a share link**, and
  honor other data-subject requests, via **dispute@job-agent.bayjf.com**.
- Demo sessions expire after 24 hours; expired sign-in sessions and unclaimed
  accounts are purged by a scheduled cleanup job.
- On-device contact details and resumes remain until you clear them locally.

#### 6. International data transfers

The production service is hosted in the Tokyo region (Vercel `hnd1`, Supabase
Northeast Asia). GitHub/Gitee public data is read from their respective APIs. By
using JobAgent you understand that public platform data is processed by those
platforms and by our Tokyo hosting. The product is designed for both Chinese and
international users.

#### 7. Your rights

Depending on your jurisdiction you may have rights to access, correct, export,
object to, or delete personal data, and to withdraw consent. Because profiles are
built from public data and are keyed by username, you can:

- View everything we hold about a username by opening its report page.
- Request deletion and share-link revocation at dispute@job-agent.bayjf.com.
- Clear all locally stored contact details yourself (extension / browser site
  data).
- Sign out, which ends your session cookie.

We will respond to verifiable requests within a reasonable period.

#### 8. Children

JobAgent is a professional developer tool not directed at children; we do not
knowingly collect data from anyone under 16 (or the minimum age in your
jurisdiction).

#### 9. Security

Credentials and secrets are held only in server-side environment variables. The
extension talks to the API through its background service worker, never touches
password fields, and sends on-device contact details only into the form you
explicitly submit. Profiles are stored as immutable snapshots so evidence cannot
silently change after a report is shared.

#### 10. Changes and contact

We may update this policy; material changes update the "last updated" date and
the hosted page. Questions, correction/deletion requests and objections:
**dispute@job-agent.bayjf.com**.

---

## 中文（简体）

### JobAgent 隐私政策

_最后更新：2026-09-24_

本政策适用于 JobAgent 网络服务（能力报告站及其 API）与 **JobAgent 自动填充**
浏览器扩展（合称"JobAgent"或"我们"）。JobAgent 只分析开发者在 GitHub、Gitee
上的**公开**活动，产出有证据背书的能力画像，将画像与岗位匹配，并帮助你在受支持
的招聘系统（ATS）上填写申请表。

我们按"尽可能少收集个人数据"的原则设计 JobAgent。

#### 1. 我们处理哪些信息

**1.1 公开代码平台数据（核心功能）。**
当你提交一个 GitHub 或 Gitee 用户名时，我们通过平台官方 API **只读取公开信息**：
公开主页、公开仓库，以及公开的 commit、Pull Request 与 Issue。我们绝不 clone
仓库、绝不申请私有仓库权限、绝不索要你在代码平台的密码。这些数据被加工成能力画像，
画像中的每条结论都链接回可公开核验的证据。

**1.2 登录数据（仅在你主动登录时）。**
不登录也能使用核心报告。如果你用 GitHub/Gitee OAuth 登录以认领本人画像，我们会收到
你的公开用户名/昵称，以及平台在授权后返回的邮箱（GitHub 为 `user:email` 授权，
可能为空；Gitee 为 `user_info` 授权）。我们保存一条账号记录，用于你认领属于自己的
画像。你的邮箱不会通过"当前登录身份"接口返回，也不会对其他用户展示。

**1.3 匿名演示限流所用的技术数据。**
匿名"试用演示"受配额限制。为在不保存你 IP 地址的前提下实现限流，我们只保存 IP
地址的**加盐 SHA-256 哈希值**，以及不透明的会话标识与时间戳；我们无法从哈希反推
你的 IP。限流记录自动过期（演示会话存活 24 小时）。

**1.4 你填写的联系方式——只存在你的设备上，绝不上传。**
你在扩展面板或报告站简历表单中填写的姓名、邮箱、电话、LinkedIn、所在地与个人网站，
**只保存在你浏览器的本地存储中**，不会传输到或持久化在我们的服务器上。它们只会在
你本人点击填充/投递动作时，写入你正在查看的申请表。你随时可以通过清除扩展本地数据
（或浏览器站点数据）把它们删除。

**1.5 你生成的简历。**
岗位定向简历在你的浏览器/本机上，根据你的画像与岗位信息装配完成。我们不在服务器上
保存简历文档或你的本地档案字段。若运营方配置了可选的 AI 润色服务，润色请求会发往
运营方配置的 OpenAI 兼容接口；AI 润色**默认关闭**，未配置时功能回退到规则版输出。

**1.6 严格必要的 Cookie 与客户端存储。**
OAuth 登录后我们设置 HttpOnly 会话 Cookie 以保持登录态。扩展使用 Chrome 的
`storage` 权限保存 1.4 所述的本机联系方式。我们不使用广告或跨站追踪 Cookie。

#### 2. 我们不收集哪些信息

- 你的 GitHub、Gitee 或 ATS 密码——扩展永不接触、也不填写密码字段，OAuth 也不
  索要密码。
- 私有仓库、私有 Issue 或任何非公开的代码平台数据。
- 支付或账单信息。
- 受支持招聘/岗位页面之外的浏览历史；扩展只在 Greenhouse、Lever、Workday 以及
  URL 含 `careers` 或 `jobs` 的页面上激活。
- 薪资、人口统计（EEO）、签证授权等敏感 ATS 字段——一键填充刻意留空，由你本人
  填写。

#### 3. 我们如何使用信息

- 生成、保存并展示有证据背书的能力画像与可分享报告页；
- 将画像与聚合的公开岗位匹配，并预填受支持的申请表；
- 完成登录认证与本人画像认领；
- 防止匿名演示配额被滥用；
- 运行、保障与排查服务（托管平台的服务器日志）。

我们不出售个人数据，也不将其用于广告。

#### 4. 共享与受托处理方

我们仅与运行 JobAgent 所必需的基础设施提供方共享数据：

| 受托方 | 用途 | 可能接触的数据 |
| --- | --- | --- |
| Vercel（托管，东京区域） | 网站、API 与定时函数 | 请求元数据、IP（用于加盐哈希）、业务数据 |
| Supabase / PostgreSQL（东京区域） | 主数据库 | 画像、证据、账号、会话、限流哈希 |
| GitHub / Gitee 官方 API | 公开开发者数据来源 | 你提交的用户名、平台返回的公开数据 |
| 运营方配置的 LLM 接口（可选，默认关闭） | 简历文本润色 | 你主动选择润色的简历文本 |

当你点击岗位链接或提交申请时，你已离开 JobAgent、直接与第三方 ATS 交互，其隐私
政策另行适用。

#### 5. 数据留存与删除

- 能力画像及其证据长期留存，以保证已分享的报告链接稳定、可核验（决策 #14）。
- 分享链接不自动过期。
- **应你的请求，我们会删除画像/证据并撤销分享链接**，并通过
  **dispute@job-agent.bayjf.com** 处理其他数据主体请求。
- 演示会话 24 小时后过期；过期登录会话与未认领账号由定时清理任务清除。
- 本机联系方式与简历由你保留，直至你在本地清除。

#### 6. 国际数据传输

生产服务托管于东京区域（Vercel `hnd1`、Supabase 东北亚）。GitHub/Gitee 公开数据
从其官方 API 读取。使用 JobAgent 即表示你理解：公开平台数据由相应平台与我们的东京
托管设施处理。本产品面向中国与海外用户同步设计。

#### 7. 你的权利

根据你所在司法辖区，你可能对个人数据享有访问、更正、导出、反对处理、删除以及撤回
同意的权利。由于画像基于公开数据、以用户名为键，你可以：

- 打开某用户名的报告页，查看我们持有的全部相关内容；
- 向 dispute@job-agent.bayjf.com 请求删除与撤销分享链接；
- 自行清除全部本机联系方式（扩展/浏览器站点数据）；
- 退出登录以结束会话 Cookie。

对可核验的请求，我们会在合理期限内回复。

#### 8. 未成年人

JobAgent 是面向专业开发者的工具，不面向儿童；我们不会在知情情况下收集 16 岁以下
（或你所在司法辖区最低年龄以下）任何人的数据。

#### 9. 安全

凭证与密钥只保存在服务端环境变量中。扩展通过后台 service worker 与 API 通信，
永不接触密码字段，且仅把本机联系方式写入你明确提交的表单。画像以不可变快照保存，
报告分享后证据不会被悄悄改动。

#### 10. 变更与联系

我们可能更新本政策；重大变更会更新"最后更新"日期与托管页面。咨询、更正/删除请求
与异议请联系：**dispute@job-agent.bayjf.com**。
