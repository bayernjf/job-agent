# @jobagent/extension — P1 Chrome 扩展（Manifest V3）

一键填充 ATS（Greenhouse / Lever / Workday）求职表单，数据来自 GitHub 验证过的
JobAgent 可信画像（决策 #15）。只做**用户主动触发**的一键填充，无后台自动投递、不存密码。

差异化：普通填充工具是"更快投出你编的简历"；本扩展是"投出 GitHub 验证过的你"——
技能项保留 `evidenceRefs` 证据引用，可回溯。

## 构建

```bash
pnpm --filter @jobagent/extension install   # 首次
pnpm --filter @jobagent/extension build      # 产物在 dist/
```

API 地址默认 `http://localhost:3000`（本地 api），可在面板中随时修改（存 localStorage）；
发布前用环境变量覆盖：

```bash
EXTENSION_API_BASE=https://api.example.com pnpm --filter @jobagent/extension build
```

## 本地加载（开发）

1. `pnpm build` 后打开 `chrome://extensions`
2. 右上角开启「开发者模式」
3. 「加载已解压的扩展程序」→ 选择本目录 `dist/`
4. 打开任一 Greenhouse / Lever / Workday 应用页，右下角出现悬浮按钮

## 使用流

输入 GitHub 用户名 → 扩展调公开 API（POST /analyze → 轮询 → GET /profiles/:id）→
展示画像字段 → 面板补填 email/教育/经历（**仅存本机 localStorage**，不上传）→ 一键填充。

## 结构

```text
src/
├─ manifest.json          # MV3 清单（content_scripts 覆盖三大 ATS 域 + careers/jobs 路径）
├─ background/index.ts    # service worker 骨架（无自动投递逻辑）
├─ content/index.tsx      # 内容脚本：检测 ATS → 注入悬浮按钮（Shadow DOM）
├─ content/panel.tsx      # 填充面板（React）：拉画像 → 本地补填 → 一键填充
├─ ats/                   # 适配器：detect / mapFields / fill
│  ├─ index.ts            # 接口 + 语义字段映射（共享）
│  ├─ greenhouse.ts / lever.ts / workday.ts
└─ lib/api.ts             # POST /analyze → 轮询 → ExportableProfile（契约校验）
```

## 边界与待办

- 仅用户主动触发；不做全自动后台投递（决策 #15 边界）
- Workday 深组件（shadow DOM）字段定位为骨架，待后续迭代
- 分发策略（Chrome Web Store vs CRX）待拍板，工程已按可打包 CRX 组织
- 图片为临时图标（程序生成的纯色 J 形），上线前替换品牌图标
