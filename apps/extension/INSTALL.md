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
3. 点 **Analyze** → 等待画像生成（约 20-30 秒）
4. 画像生成后，面板自动展示 **top 5 匹配岗位** 和 **匹配依据**
5. 在 Greenhouse/Lever 申请表单点 **Fill** 可一键填充姓名/邮箱/简历链接

## 支持的 ATS 平台

| 平台 | URL 模式 | 填充能力 |
|---|---|---|
| Greenhouse | `*.greenhouse.io/*` | 姓名/邮箱/简历/自定义问题 |
| Lever | `jobs.lever.co/*` | 姓名/邮箱/简历/自定义问题 |
| Workday | 各企业租户 | 字段识别（真实直渲染页面待验证） |

## 故障排查

- **面板不弹出**：刷新招聘页面，或检查 `chrome://extensions/` 中扩展是否启用
- **API 连接失败**：确认后端服务在 `localhost:3000` 运行，且面板中 API 地址正确
- **Analyze 一直 pending**：确认 Worker 终端在运行（会打印 `[worker]` 日志）
- **404 错误**：GitHub 用户名不存在，换一个确认存在的

## 本地档案跨端同步（扩展 ↔ 报告页）

扩展面板（ATS 页）与报告页简历补填（`/report/:id`）共享同一份本地档案（email/电话/所在地/LinkedIn + 教育/工作经历），数据经扩展 `chrome.storage` 自动互通、仅存本机，不上传服务端。

- **固定扩展 ID**：本扩展 manifest 内置 `key`，加载后 ID 固定为 `dgbnkdljapgglpdcmncbleioocbjfmmc`。若此前加载过旧版扩展（无 `key`），需先移除旧版再重新「Load unpacked」本目录，否则 ID 不同、报告页无法连通。
- **报告页需在 `externally_connectable` 白名单域**：当前白名单为 `http://localhost:4321`、`http://127.0.0.1:4321` 与生产占位 `https://job-agent.bayjf.com`。本地跑报告页请用 `localhost:4321`（`pnpm --filter @jobagent/report dev`）。
- **同步方向**：扩展面板填的 email/电话/所在地/LinkedIn 会自动带到报告页简历补填；报告页填的完整档案会自动带到扩展 ATS 填充。任一端未装扩展 / 非 Chrome 浏览器时自动降级为仅本端 localStorage，互不影响。
