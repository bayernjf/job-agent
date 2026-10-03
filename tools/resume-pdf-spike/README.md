# resume-pdf-spike

简历 ↔ 画像「对账」前置验证：**PDF 文本抽取 spike**。

## 目标

验证「用户上传 PDF 简历 → 文本层抽取 → 结构化字段声明」管线的可行性，重点回答两个问题：

1. **抽取质量**：pdf.js（经 `pdf-parse`）对中英混排、分栏、含表格的简历 PDF，文本抽取的字符覆盖率（抽净率）能否达标？
2. **「原文不留存」能否代码级强制**：抽取管线只输出结构化声明（字段值 + 统计 + 覆盖率），不落盘任何原文段落——不靠约定，靠 schema 与守卫测试。

## 结论（2026-10-03，合成样本）

| 指标 | 实测 | 达标线 |
|---|---|---|
| 平均字符抽净率 | **97.9%** | ≥ 95% |
| 最低样本抽净率 | 93.4%（en-major，英文为主） | ≥ 90% |
| 字段可提取性 | 姓名/邮箱全部命中 | email + name 必中 |

- **中文抽取近乎无损**（zh-major 100%）；英文为主样本 93.4% 的缺口来自个别字符形态（如连字符/全角标点），文本层整体可用。
- pdf-parse 对 pdf-lib 嵌入字体的 PDF 打印 `Ran out of space in font private use area` 警告——这是 pdf.js 处理 PUA 映射的提示，**不影响文本抽取**；真实简历多由 Word/LaTeX 生成（标准 CID 字体），无此问题。
- **字段结构化**（把文本切成 name/email/experience 等）在本 spike 用简单规则演示（字段命中率 73.3%，玩具级别）；真实简历布局多样，字段解析是**生产化阶段**的工作，不在本 spike 达标口径内。
- **「原文不留存」已代码级强制**：输出 schema 无 `rawText/pagesText` 字段；守卫测试断言报告不含源文本长行（经历/项目描述整句）、抽取过程不产生任何 .txt/.raw 原文文件。

## 达标口径与后续

- deferred 行触发条件为「**5 份真实**中英混排简历做文本抽取 spike，抽净率达标再进 PRD 排期」。
- **本 spike 使用 5 份合成样本**（用户已确认先用合成样本跑通管线）；真实样本的达标测量待用户提供 5 份脱敏简历后补充（同一套 make-fixtures/extract/test 可复用）。
- 真实样本验证通过后，方可进入 PRD 排期（`resume` 上传端点、`原文不留存` 存储约束、对账三态）。

## 复现

```bash
cd tools/resume-pdf-spike
pnpm install --ignore-workspace   # tools/ 不在 workspace packages 列表，需独立安装
pnpm make-fixtures                # 生成 5 份合成简历 PDF + sources.json（需 fonts/ 中文字体）
pnpm extract                      # 抽取 + 结构化声明 + 抽净率对账 → resume-extract.json
pnpm test                         # 守卫测试（不留存/抽净率/字段提取）
```

> 中文字体：`fonts/NotoSansSC-Regular.ttf`（Noto Sans CJK SC，约 16MB，已 gitignore）。
> 下载：`curl -L -o fonts/NotoSansSC-Regular.ttf "https://cdn.jsdelivr.net/gh/notofonts/noto-cjk@main/Sans/OTF/SimplifiedChinese/NotoSansCJKsc-Regular.otf"`

## 目录

```
tools/resume-pdf-spike/
├─ fonts/            # 中文字体（gitignore，不进库）
├─ fixtures/         # 合成样本 PDF + sources.json（PDF 为生成物，gitignore）
├─ src/
│  ├─ make-fixtures.js   # 生成 5 份中英混排合成简历（单栏/双栏/表格等变体）
│  ├─ extract.js         # 抽取 → 结构化声明 + 抽净率（导出纯函数，可测试）
│  └─ extract.test.js    # 守卫测试：原文不留存 + 抽净率 + 字段提取
├─ resume-extract.json   # 抽取报告（生成物，gitignore）
└─ package.json
```
