# Chrome Web Store listing assets

Marketing assets for publishing the JobAgent Autofill extension to the Chrome Web
Store (CWS). This folder is **not** shipped in the extension bundle (`dist/`); it
only holds the reproducible capture script, a mock ATS host page and the exported
images.

## Asset inventory and required sizes

Specs below were taken from the official Chrome for Developers documentation
(see [Sources](#sources)). Screenshots are full bleed (square corners, no
padding); promotional tiles must convey the brand, not just be screenshots.

| File | Size | Required | Notes |
| --- | --- | --- | --- |
| `screenshots/01-extension-job-matches.png` | 1280×800 | 1–5 allowed | Matched jobs panel on a Lever application page |
| `screenshots/02-match-basis-evidence.png` | 1280×800 | optional | Expanded score breakdown + skill/evidence trace |
| `screenshots/03-one-click-autofill.png` | 1280×800 | optional | The ATS form populated after one click |
| `screenshots/04-verified-profile.png` | 1280×800 | optional | Public verified ability report (web) |
| `screenshots/05-talent-pool.png` | 1280×800 | optional | Recruiter candidate search (web) |
| `promo/small-440x280.png` | 440×280 | **required** | Small promotional tile |
| `promo/marquee-1400x560.png` | 1400×560 | optional (required to be featured) | Wide marquee tile |

CWS accepts screenshots at 1280×800 or 640×400 (the store downscales to
640×400); we ship 1280×800 for crisp rendering. The in-package icon is
128×128 PNG (artwork 96×96 with 16 px transparent padding per side) and lives
in `../src/icons/`, not here. There is **no** 920×680 tile in the current spec.

## Reproducing the captures

The extension panel talks to the **real local API** (real exportable profile and
real job matches); only the ATS host page is a local mock (`ats-job.html`),
routed in exactly like the extension E2E. Use Node 22 for capture (the local
`better-sqlite3` build matches its ABI); do not switch to the `.nvmrc` Node 24
without rebuilding native deps.

1. Prepare a local SQLite database and run migrations, then start the API, worker
   and report app against the same DB (see the root `AGENTS.md` / deployment
   runbook for the per-app commands).
2. Produce a complete profile and a populated job table, e.g. trigger an analysis
   for a demo login (`POST /analyze`, or `jobagent analyze <login>` in the CLI)
   and run `jobagent jobs sync`.
3. Build the extension:
   ```sh
   pnpm --filter @jobagent/extension build
   ```
4. Capture all assets (set `PROFILE_ID` to a complete profile in the local DB;
   optional `API_BASE`, `REPORT_BASE`, `LOGIN` overrides default to
   `http://127.0.0.1:4123`, `http://127.0.0.1:4321`, `bayernjf`):
   ```sh
   PROFILE_ID=<profile-uuid> node apps/extension/store-assets/capture.mjs
   ```
   The script forces `locale: 'en-US'` so the panel renders English regardless of
   the OS language. Verify every PNG with
   `sips -g pixelWidth -g pixelHeight <file>` before uploading.

Before a **production** listing release, build the extension in release mode
(strips every localhost grant, pins the production site origin, and refuses to
build against a localhost API):

```sh
EXTENSION_RELEASE=1 \
EXTENSION_API_BASE=https://<app-origin>/api \
EXTENSION_SITE_ORIGIN=https://<app-origin> \
pnpm --filter @jobagent/extension build
```

Then re-run the captures so the advanced "API endpoint" field and every panel
link point at production rather than the `http://localhost:3000` placeholder.

## Pre-submit checklist (CWS)

Work through this before uploading the zip to the Chrome Web Store. Items marked
**[decision]** depend on the production deployment (Form C execution sheet) and
cannot be closed by code alone.

1. **[decision] Production domain decided** (B1, suggested `app.job-agent.bayjf.com`).
   The committed `src/manifest.json` still contains the placeholder
   `https://job-agent.bayjf.com` (the landing-page domain) plus localhost grants;
   do not ship it verbatim. The release build above rewrites the placeholder and
   strips localhost entries — verify `dist/manifest.json` afterwards.
2. **Release build green**: `EXTENSION_RELEASE=1` build refuses localhost
   `EXTENSION_API_BASE`/`EXTENSION_SITE_ORIGIN`; confirm `dist/manifest.json`
   contains no `localhost`/`127.0.0.1` entry and the API base is the same-origin
   `/api` URL (the panel calls the API through the background service worker).
3. **Screenshots recaptured with current code + production build** (see
   [Known capture-time caveats](#known-capture-time-caveats)): the tracked
   screenshots date from 2026-09-21 and screenshot 02 still shows pre-item41
   **Chinese evidence claims**; recapture requires a profile regenerated after
   the English-claim change (item41, commit `3ddd18c`). Re-run the captures with
   the release build so no `localhost` UI is visible.
4. **Fixed extension ID preserved**: `src/manifest.json` ships a `key`
   (derived ID `dgbnkdljapgglpdcmncbleioocbjfmmc`) so the CWS listing, the
   report page's `externally_connectable` calls and existing unpacked users keep
   one identity. `key.pem` must stay out of git/public bundles; after the first
   CWS publish, dev unpacked copies with the same key upgrade in place, older
   copies without it should be removed to avoid double-install confusion.
5. **Image sizes verified**: 5× 1280×800 screenshots, 440×280 small tile
   (required), 1400×560 marquee (required for featuring), 128×128 in-package
   icon — check with `sips -g pixelWidth -g pixelHeight <file>`.
6. **Listing copy pasted** from [Store listing copy](#store-listing-copy) below
   (en + zh-CN); confirm the detailed-description length against the live CWS
   dashboard input.
7. **CWS metadata prepared**: category Productivity; single-purpose statement
   (one-click ATS autofill from a verified profile); permission justifications
   for `storage` and the host patterns (the broad `*/*careers*`、`*/*jobs*`
   globs exist to catch customer-hosted ATS pages — expect a review question);
   privacy practices (no collection of personal data by the extension; email/
   phone/LinkedIn stay local; passwords never touched) and a privacy-policy URL
   on the deployed site.
8. **Production API live** before submission review: presets and
   `GET /profiles/by-subject/:platform/:login` must answer on the production
   origin, otherwise the panel shows empty states during review.

## Store listing copy

### English

- **Name:** JobAgent Autofill
- **Summary (manifest short description, 84/132 chars):**
  One-click autofill of ATS application forms from a GitHub-verified JobAgent profile.
- **Category:** Productivity
- **Languages:** English, 中文（简体）

**Detailed description:**

> JobAgent turns your real public GitHub work into a verified, evidence-backed
> ability profile, then helps you apply in one click.
>
> How it works
> 1. Generate your free JobAgent profile. We analyze public commits, pull
>    requests and issues — no repository cloning, no private data — and rank
>    every skill with a confidence level and a link back to the public evidence.
> 2. Open a supported application page (Greenhouse or Lever). The extension
>    lists openings ranked by skill match and explains each score with a
>    title/tags/description breakdown and the exact skills and repositories
>    behind it.
> 3. Enter your name, email and contact details locally, then click once to
>    populate the application form, including a tailored self-statement for
>    motivation-style questions.
>
> Why JobAgent
> - Evidence-backed: every skill claim links to public commits, PRs and issues.
> - Transparent authenticity: signals such as commit bursts or self-owned pull
>   requests are shown, never hidden.
> - Private by design: the extension never sees your passwords. Email, phone and
>   LinkedIn stay on your device and are only written into the form you submit;
>   your resume is never uploaded and salary/authorization fields are left alone.
> - Verifiable: every profile has a shareable report page so recruiters can
>   inspect the same evidence you see.
>
> Only public GitHub/Gitee information is read. You can clear all locally stored
> details at any time.

### 中文（简体）

- **名称：** JobAgent 自动填充
- **一句话简介（manifest 短描述，45 字符）：**
  基于 GitHub 验证的 JobAgent 可信画像，一键填充招聘系统（ATS）申请表。
- **分类：** 生产力工具

**详细描述：**

> JobAgent 把你在 GitHub 上真实、公开的工作沉淀为一份有证据背书、可复核的
> 能力画像，并帮助你一键完成投递。
>
> 工作方式
> 1. 免费生成你的 JobAgent 画像：我们只分析公开的 commit、Pull Request 与
>    Issue（不 clone 仓库、不触碰私有数据），每项技能都给出置信度，并链接回
>    可公开核验的证据。
> 2. 打开受支持的招聘页面（Greenhouse 或 Lever）：扩展会按技能匹配度为岗位
>    排序，并通过标题/标签/描述的打分拆解，说明每个分数背后的确切技能与仓库。
> 3. 在本地填写姓名、邮箱与联系方式，点击一次即可填充申请表，并为动机类问题
>    生成贴合岗位的自我陈述。
>
> 为什么选择 JobAgent
> - 证据背书：每条技能声明都能追溯到公开的 commit、PR 与 Issue。
> - 真实性透明：集中提交、自有仓库 PR 等信号会被如实呈现，绝不隐瞒。
> - 隐私优先：扩展不接触你的密码；邮箱、电话、LinkedIn 仅保存在本机，只写入
>   你主动提交的表单；不上传简历，也不填写薪资/授权类字段。
> - 可核验：每份画像都有可分享的报告页，招聘方看到的证据与你完全一致。
>
> 仅读取公开的 GitHub/Gitee 信息，你可随时清除本机保存的全部资料。

> The detailed description field has no documented fixed character limit; confirm
> against the live CWS dashboard input when pasting.

## Known capture-time caveats

- Screenshot 02 surfaces repository evidence lines. The collection-layer claim
  templates were localized to English in item41 (commit `3ddd18c`, 2026-09-22),
  but the **tracked screenshots were captured 2026-09-21 against a profile
  snapshotted before that change**, so 02 still shows Chinese evidence claims
  (`仓库 … 1 star / 0 fork，最近推送 …`). Recapture after regenerating the
  demo profile with current code (the evidence text is stored on the snapshot
  and is not re-translated at render time). The score breakdown itself is
  language-neutral.
- The demo report uses the public demo preset logins (including well-known public
  accounts). All displayed data is public behavioural information with no private
  contact fields; swap the preset accounts before publishing if desired.

## Sources

Official Chrome Web Store image and listing requirements (raw markdown from the
`GoogleChrome/developer.chrome.com` repository; the rendered docs site is a SPA
that is not retrievable with a plain HTTP client):

- https://raw.githubusercontent.com/GoogleChrome/developer.chrome.com/main/site/en/docs/webstore/images/index.md
- https://raw.githubusercontent.com/GoogleChrome/developer.chrome.com/main/site/en/docs/webstore/prepare/index.md
- https://raw.githubusercontent.com/GoogleChrome/developer.chrome.com/main/site/en/docs/webstore/cws-dashboard-listing/index.md
