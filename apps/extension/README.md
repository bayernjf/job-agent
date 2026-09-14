# JobAgent 浏览器扩展（试用指南）

一键把 GitHub 可信画像填充到招聘 ATS 表单（Greenhouse / Lever），Workday 已具备字段定位能力、受平台限制待验证（见下文）。数据只来自你主动触发的填充，不做全自动后台投递。

## 前置：本地服务

需要本地跑起 api 与 worker（扩展面板拉取画像依赖）：

```bash
pnpm --filter @jobagent/api dev        # 终端 1，监听 http://localhost:3000
pnpm --filter @jobagent/worker dev     # 终端 2，轮询消费分析任务
```

首次使用前先分析你的 GitHub 账号（生成可信画像）：

```bash
pnpm --filter @jobagent/cli dev analyze <你的GitHub用户名>
```

## 安装扩展（开发者模式手动加载）

1. 构建扩展产物：`cd apps/extension && pnpm build`（产物在 `apps/extension/dist`）。
2. 打开 `chrome://extensions`，右上角开启「开发者模式」。
3. 点「加载已解压的扩展程序」，选择 `apps/extension/dist` 目录。
4. 工具栏出现扩展图标即安装成功（图标当前为占位图，正式图标上架前替换）。

> 分发说明：当前以 CRX / unpacked 手动加载先行（零门槛、零成本、不暴露源码）；Chrome Web Store 待真实反馈后再上（需正式图标 + 商店物料 + 审核）。

## 使用

1. 打开 Greenhouse（如 `job-boards.greenhouse.io/<公司>`）或 Lever（`jobs.lever.co/<公司>`）岗位页。
2. 点页面的 **APPLY / Apply for this job**，等表单出现（表单是点击后才渲染的）。
3. 页面右下角点悬浮按钮「JobAgent」打开面板（面板头部可一键切换中/英文，选择记在本机 localStorage；浏览器语言默认按 `navigator.languages` 协商）。
4. 输入 GitHub 用户名 →「获取可信画像」（显示真实性与技能标签）。
5. 画像加载后面板自动展示「岗位匹配」区块：从岗位库取 top 5 匹配岗位，每条显示匹配分（高/部分/弱三档色）、岗位@公司外链、命中技能；展开「匹配依据」可看分数在标题/标签/正文上的分解、技能深度与可回溯的 GitHub 证据链接。匹配加载不影响填充，岗位库为空或接口失败时显示对应空态/错误态（可重试）。
6. 点「填充到表单」：name / GitHub 等画像中存在的字段自动写入。
7. 可选「本地补填」：email / phone / LinkedIn / location 填一次后仅存本机 localStorage，之后自动带上。

## 已知限制

- **Workday**：求职端岗位详情页普遍外链官网或仅渲染导航壳（实测 NVIDIA/GM/Walmart/FMC 四家均无法取得可填表单），字段定位已支持 shadow DOM，待找到直接渲染表单的租户页再端到端验证。
- **Greenhouse summary**：cover_letter 为 file input，适配器未填该字段（待 question_* 自定义字段映射）。
- 填充命中依赖画像与表单字段语义匹配；本地补填字段未配置时对应表单项留空，请手动补充。
