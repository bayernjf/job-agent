# 浏览器扩展 Playwright E2E 设计（2026-09-14）

> 状态：现行。为 `apps/extension` 补真实浏览器级 E2E，覆盖 content script 注入、Shadow DOM 面板渲染与岗位匹配区块。纯函数逻辑仍由 Vitest 就近单测负责，本设计只补"真实扩展在真实页面里跑起来"这一层。

## 1. 背景与断层

- 扩展当前质量门：Vitest 纯函数/纯逻辑单测 55 个（ats 语义映射、api 客户端、i18n、match-utils、tokens-guard）+ esbuild build 成功。
- 未覆盖层：**content script 真实注入 → Shadow DOM 挂载 → React 面板交互 → 匹配区块 DOM 渲染**这条链路从未在自动化里跑过；2026-09-14 新增的面板岗位匹配 UI（`design-extension-match-ui-20260914.md`）只被单测间接覆盖。
- 真实 Greenhouse/Lever 冒烟是人工一次性验证（handoff 记录），不可回归、不进 CI。需要一个确定性、可重复、进 CI 的浏览器级回归网。

## 2. 技术可行性（已 spike 验证，2026-09-14 本机）

Playwright `1.63` + Chromium 加载 unpacked MV3 扩展的结论（已用最小脚本实测，非推断）：

1. 必须用 `chromium.launchPersistentContext(userDataDir, { args: ['--disable-extensions-except=<dist>', '--load-extension=<dist>'] })`，普通 `browser.newContext()` 不加载扩展。
2. **可纯无头运行**：`headless: false` 同时在 args 传 `--headless=new`（Chromium 新无头），service worker 成功注册（`context.serviceWorkers().length === 1`）、content script 正常注入。CI（ubuntu）因此**不需要 xvfb**。旧的 `headless: true` 不加载扩展，不能用。
3. 面板挂在 `mode:'open'` 的 Shadow DOM 内，Playwright 的 `page.locator()` 默认穿透 open shadow root，**无需手动取 shadowRoot**（`elementHandle.shadowRoot()` 不是函数，勿用）。
4. content script 的 `matches` 只含 **https** 且要求 URL 路径含 `jobs`/`careers`（或特定 ATS 域）；本地 http server 不匹配。用 `context.route('https://example.com/jobs', r => r.fulfill({html}))` 拦截一个符合 pattern 的 https URL 并回灌本地 HTML，content script 即注入，确定性且零网络。
5. ATS 识别：回灌 HTML 含 `lever`/`greenhouse` 文本或对应表单选择器即可被 `detectAts` 命中（见 `ats/*.ts` 的 detect）。

## 3. 架构：独立配置，不与 report E2E 混用

现有 `playwright.config.ts` 面向 report：`testDir=./e2e`、webServer 拉起 Astro、用内置 browser/page fixture。扩展 E2E 机制本质不同（persistent context + 加载扩展 + 无 Astro），硬塞进同一配置会让 webServer/fixture 互相干扰，因此：

- 新增 `playwright.extension.config.ts`：`testDir=./e2e/extension`，单 chromium project，**无 webServer**，`workers:1`、`fullyParallel:false`（扩展实例与 user-data-dir 串行更稳）。
- 测试放 `e2e/extension/`，与 report 用例物理隔离；根 `package.json` 加脚本 `e2e:extension`；原 `pnpm e2e`（report）不变。
- CI 在现有 "E2E tests"（report）后追加一步 "Extension E2E tests"，复用已安装的同一 Chromium（`playwright install --with-deps chromium` 已含新无头能力），无需额外系统依赖。

### 3.1 自定义 fixture（`e2e/extension/extension-test.ts`）

导出 `test`/`expect`（基于 `@playwright/test` 的 `test.extend`），在 fixture 内：

1. 为每个 worker/test 建临时 user-data-dir（`os.tmpdir()` 下，`finally` 清理）。
2. `launchPersistentContext` 加载 `apps/extension/dist`，args 带 `--headless=new`（本地可用 `HEADED=1` 切真有头便于调试）。
3. 统一 `context.route`：
   - `**/jobs`（ATS 模拟页）→ 回灌含 lever 识别文本 + 假表单的 HTML；
   - `**/analyze` → 直接返回 `{ profileId }`（跳过轮询，不模拟 /jobs）；
   - `**/profiles/*/exportable` → 合法 ExportableProfile；
   - `**/job-postings/match` → 默认匹配列表 fixture，可在用例内覆盖（空态/错误态）。
4. 暴露：`extPage`（已导航到 ATS 模拟页、悬浮按钮已就绪的 Page）、`setMatchBody(body, status?)`（用例级覆盖 match 响应）、`openPanel()`（点 `.ja-fab` 展开面板）。

> 为什么默认让 /analyze 直接回 profileId：扩展 `fetchProfile` 在缓存命中时本就走这条短路（api.ts），E2E 关注面板渲染而非轮询，去掉 /jobs 轮询链路更快更确定。

## 4. 测试数据

- **ExportableProfile**：复用 `e2e/fixtures/sample-profile.ts` 的 `buildFixtureProfile()`（AbilityProfile），经 `toExportableProfile()` 转换得到，保证严格符合 shared 契约、不手抄易漂移的扁平结构。
- **match 响应**：2~3 条 JobMatchItem，刻意覆盖三档——单技能高分（high）、双技能中分（mid）、低分（low），带 fieldScores/skillReasons 与顶层 evidence 字典，用于断言三档 class 与匹配依据展开。
- **ATS HTML**：`<h1>...Lever...</h1>` + `#job-application-form` 假表单，满足 lever.detect。

## 5. 首批用例（match-panel.spec.ts）

1. **注入与打开**：导航后 `.ja-fab` 出现；点击后面板出现、用户名输入框可见。
2. **匹配列表渲染（主链路）**：输入用户名 → submit → 画像区出现 → `.ja-match-list` 渲染对应条数；每条有分数、`title @company`、命中技能 chip；分数元素带正确的 `ja-match-score-{high|mid|low}` class（验证 shared.matchScoreTier 真实接线）。
3. **匹配依据展开**：展开 `details.ja-match-basis`，可见 title/tags/desc 分数分解与 Evidence 外链（href 正确、target=_blank）。
4. **空态**：match 返回 `{matches:[]}` → 显示空态文案。
5. **错误态与重试**：match 首次 500 → 显示错误 + Retry；点击 Retry 后用 200 恢复 → 列表渲染（验证重试不刷新画像）。

断言一律 scope 到面板/匹配区块内；文案走英文（persistent context 默认 en，断言用 en.json 现行文案，不硬编码中文）。

## 6. 明确不做（边界）

- **不连真实 ATS / 不打网络**：真实 Greenhouse/Lever 页面渲染属真人试用（handoff 已记录手动冒烟），自动化只保证"扩展机制 + 面板渲染"回归。
- **不验证一键填充的真实 DOM 写入**：ats 层字段语义映射已有 12 个就近单测；填充端到端属真实站点验证。
- **不测试 background service worker 逻辑**：当前 background 仅占位（48B），无行为可测；未来若加消息/存储逻辑再补。
- **不做视觉回归截图比对**：样式由 tokens-guard 单测与人工负责，E2E 只断言结构与文本，避免脆弱的像素比对。

## 7. 验收标准

- `pnpm e2e:extension` 在本机新无头下 5 用例全绿；`pnpm e2e`（report）不受影响、仍 15 全绿。
- 全仓 typecheck（含 e2e/extension 的 .ts）通过；测试不依赖网络、不依赖 dev server、不依赖真实 API。
- CI 新增扩展 E2E 步骤绿（只能 push 后由 Actions 最终确认，本地先全绿）。
- 临时 user-data-dir 用后即清，不污染仓库（产物入 .gitignore）。

## 8. 未决 / 待核实

- CI ubuntu runner 上 `--headless=new` 加载扩展的稳定性以首次 Actions 运行为准；若个别 runner 异常，回退方案是该步骤套 `xvfb-run --auto-servernum`（真有头），fixture 已预留 `HEADED` 开关。
