# JobAgent 浏览器扩展 — 试用安装指南

## 前置条件

1. **Node.js 24+** 和 **pnpm** 已安装
2. **GITHUB_TOKEN**（fine-grained PAT，public repo read-only）已获取

## 第一步：启动后端服务

```bash
# 在仓库根目录
pnpm install
pnpm -r build

# 终端 1：启动 API
GITHUB_TOKEN=ghp_xxxx PORT=3000 node apps/api/dist/index.js

# 终端 2：启动 Worker（消费分析任务）
GITHUB_TOKEN=ghp_xxxx node apps/worker/dist/index.js
```

验证：`curl http://localhost:3000/health` 应返回 `{"status":"ok"}`。

## 第二步：构建扩展

```bash
pnpm --filter @jobagent/extension build
# 输出在 apps/extension/dist/
```

## 第三步：加载到 Chrome

1. 打开 Chrome，地址栏输入 `chrome://extensions/`
2. 右上角打开 **Developer mode**（开发者模式）
3. 点 **Load unpacked**（加载已解压的扩展程序）
4. 选择目录：`apps/extension/dist/`
5. 扩展出现在列表中，版本 0.1.0

## 第四步：试用

1. 在任意 Greenhouse / Lever 招聘网站页面打开扩展面板（点右上角悬浮球）
2. 首次使用时，在面板顶部设置 **GitHub/Gitee 用户名** 和 **API 地址**（默认 `http://localhost:3000`）
3. 点 **Analyze** 加载画像：若该账号已有生成好的 complete 画像快照会**直接加载**（走公开只读 by-subject 查询，不触发新分析、不受 24h 缓存 TTL 与演示配额限制，见「故障排查」）；仅当没有快照时才触发新分析（约 20-30 秒，受演示配额约束）
4. 画像加载后，面板自动展示 **top 5 匹配岗位** 和 **匹配依据**
5. 在 Greenhouse/Lever 申请表单点 **Fill** 一键填充：first/last name、Email、Phone、所在城市（Location/City）、Website（个人站点）、GitHub/LinkedIn（本地档案有则填），以及 “Why do you want to work here?” 类自定义开放问题（写入画像 summary）。EEO（性别/种族）、薪资、授权勾选、“How did you hear about us?” 等字段刻意留空；**扩展不会替你点击 Submit**，提交前请自行逐字段核对

## 支持的 ATS 平台

| 平台 | URL 模式 | 填充能力 |
|---|---|---|
| Greenhouse | `*.greenhouse.io/*` | 姓名/邮箱/电话/城市/Website/GitHub/LinkedIn/自定义开放问题（2026-09-22 真机验证；电话区号框与城市框已消歧，城市不会误填进区号） |
| Lever | `jobs.lever.co/*` | 姓名/邮箱/电话/Website/GitHub/LinkedIn/自定义问题（字段收集含 `tel`/`url` 输入） |
| Workday | 各企业租户 | 字段识别（真实直渲染 `data-automation-id` 表单页面待验证） |

## 故障排查

- **面板不弹出**：刷新招聘页面，或检查 `chrome://extensions/` 中扩展是否启用
- **API 连接失败**：确认后端服务在 `localhost:3000` 运行，且面板中 API 地址正确
- **Analyze 一直 pending**：确认 Worker 终端在运行（会打印 `[worker]` 日志）
- **404 错误**：GitHub/Gitee 用户名不存在，换一个确认存在的；若该平台确无画像快照，单源会回退到触发新分析
- **HTTPS 招聘页里 API 报 `Failed to fetch` / status 0（重要）**：扩展**不在招聘页（content script）里直接请求 API**，而是把所有 API 请求交给 **background service worker 代发**（扩展源请求，规避 HTTPS 页对 `http://localhost` 的 CORS / 混合内容 / 私有网络访问限制）。出现该错先确认：①后端在面板配置的 API 地址上运行；②该地址已在扩展 `manifest.json` 的 `host_permissions` 中（本地默认含 `http://localhost:3000`、`http://127.0.0.1:3000`）。
- **改过代码 / `host_permissions` / manifest 后改动不生效**：必须先 `pnpm --filter @jobagent/extension build` 重建 `dist/`，再到 `chrome://extensions/` 点 JobAgent 卡片自己的「重新加载」（reload）按钮，最后**刷新招聘页标签页**；仅刷新招聘页不会重载 manifest 权限。
- **加载已生成画像却提示 403 / 要求演示会话（DEMO_REQUIRED）**：单源（GitHub/Gitee）加载时扩展会先查公开只读端点 `GET /profiles/by-subject/:platform/:login`，命中已生成的 complete 快照就直接加载，**不看 24h 缓存 TTL、不扣演示配额、不触发新分析**；只有查无快照（404）才回退 `POST /analyze` 触发新分析（匿名受每会话 3 次 / 24h 演示配额限制，登录用户不限）。若旧画像仍 403，确认扩展已重建为含 by-subject 逻辑的最新版本并按上一条重新加载。
- **匹配岗位为空**：匹配在本地岗位库中进行，需后端已跑过岗位同步（`jobagent jobs sync`）；这与画像加载、一键填充相互独立，不影响填表。

## 本地档案跨端同步（扩展 ↔ 报告页）

扩展面板（ATS 页）与报告页简历补填（`/report/:id`）共享同一份本地档案（email/电话/所在地/LinkedIn + 教育/工作经历），数据经扩展 `chrome.storage` 自动互通、仅存本机，不上传服务端。

- **固定扩展 ID**：本扩展 manifest 内置 `key`，加载后 ID 固定为 `dgbnkdljapgglpdcmncbleioocbjfmmc`。若此前加载过旧版扩展（无 `key`），需先移除旧版再重新「Load unpacked」本目录，否则 ID 不同、报告页无法连通。
- **报告页需在 `externally_connectable` 白名单域**：当前白名单为 `http://localhost:4321`、`http://127.0.0.1:4321` 与生产占位 `https://job-agent.bayjf.com`。本地跑报告页请用 `localhost:4321`（`pnpm --filter @jobagent/report dev`）。
- **同步方向**：扩展面板填的 email/电话/所在地/LinkedIn 会自动带到报告页简历补填；报告页填的完整档案会自动带到扩展 ATS 填充。任一端未装扩展 / 非 Chrome 浏览器时自动降级为仅本端 localStorage，互不影响。
- **当前两端字段差异（待对齐，handoff item46 遗留）**：报告页简历补填表单可填 **个人网站（personalSite）**，但暂无 LinkedIn 输入框；扩展面板 Local details 可填 **LinkedIn**，但暂无个人网站输入框。因此 **LinkedIn 目前只能在扩展面板补、个人网站只能在报告页补填后同步到扩展**（同步通道本身正常，真机已验证个人网站能从报告页推到扩展并填入 ATS 的 Website 框）；email/电话/所在地两端都可填。是否把两端字段补齐对齐待产品拍板。
