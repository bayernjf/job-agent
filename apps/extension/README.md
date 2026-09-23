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
4. 工具栏出现扩展图标即安装成功（正式品牌图标已于 2026-09-18 替换占位图，16/48/128 三尺寸）。

> 分发说明：当前以 CRX / unpacked 手动加载先行（零门槛、零成本、不暴露源码）；Chrome Web Store 上架素材（5 张 1280×800 截图 + 宣传图 + 中英 listing）已于 2026-09-21 备齐（见 [store-assets/README](store-assets/README.md)），发布包用 `EXTENSION_API_BASE=https://<生产域>/api EXTENSION_SITE_ORIGIN=https://<生产域> pnpm --filter @jobagent/extension release` 一键构建 zip；上架仍待形态 C 生产 API 上线后用生产构建重截截图。

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
- **Greenhouse/Lever 自定义问题**：summary→question_* 映射已落地（`findLabeledQuestion` + 关键词表，含动机类问题）；cover_letter 为 file input 时自动跳过、改走问题文本字段；真实公司问题措辞不在词表内、薪资/授权类字段刻意不填仍是预期边界。
- 填充命中依赖画像与表单字段语义匹配；本地补填字段未配置时对应表单项留空，请手动补充。
