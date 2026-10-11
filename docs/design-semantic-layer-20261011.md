# L3 语义层设计（2026-10-11）

> 状态：现行（**L3-A 已按本文档落地**，2026-10-11；L3-B/C 待拍板）。
> 定义出处：[PRD §4.2 注记](PRD.md)（"基于代码 / README 的领域与设计决策推断，仍可不 clone，先用 API 取关键文件内容"）、[PRD §7 分析分层](PRD.md)（`L3 语义 / AI · P1起`）、[deferred-items #L3/L4](deferred-items.md)。
> 本文档只写设计与决策，实施进度记 [handoff.md](../handoff.md)。

## 1. 背景与口径拍板

PRD §4.2 与 deferred-items 对 L3 存在**口径冲突**：

| 出处 | 口径 |
| --- | --- |
| PRD §4.2 / §7 / M2 | L3 **不依赖 clone**，先用 API 取关键文件内容做语义推断（P1 起） |
| deferred #L3/L4 | "依赖 L2 的代码获取与沙箱先成立，逐级递进" |

**拍板（2026-10-11，用户确认）**：以 PRD 为准——**L3 先行、不 clone**；deferred 的"依赖 L2"口径改写为"仅当 L3 需要完整代码语义（而非关键文件）时才依赖 L2"。本设计不再要求 L2 前置。

**为何 L3 值得做**：L0（语言构成/star）与 L1（行为时序）都回答"这个账号活跃吗"，但回答不了"**这个人做的到底是什么、做得好不好**"。L3 从公开的关键文件（README / 依赖清单 / CI / 测试目录）补上"领域、技术栈、工程成熟度"这一维，直接增强：
- 面试问题（M2 里程碑"L3 语义问题增强"）：从"你做过什么项目"升级到"你项目里的技术决策"
- 匹配质量（岗位画像匹配的 tag 命中率）
- 真实性分级（README 声称 vs 代码实际，L3-C）

## 2. 分层定义（L3-A / L3-B / L3-C）

| 层 | 内容 | LLM | 成本 | 状态 |
| --- | --- | --- | --- | --- |
| **L3-A** | 不 clone 取关键文件 + **规则版**语义信号（工程成熟度 / 技术栈 / 领域 / 仓库类型） | 无 | 每画像 ≤~8 次 REST（预算内） | ✅ 已落地 |
| **L3-B** | LLM 语义分析：README 摘要、设计决策推断、声称 vs 实际差距、面试问题增强 | 需要（复用 LLM 双轨） | 每画像 1 次 LLM 调用 | 待拍板（成本/配额） |
| **L3-C** | 语义真实性：README 声称能力 vs 代码实际交叉核验并入真实性信号 | 建议规则优先 | 复用 A/B 数据 | 待拍板（升 RULE_VERSION） |

**本次落地范围＝L3-A 独立闭环**：新契约 + 新采集包 + 新纯函数包 + CLI 命令 + 测试；**不碰 analyzer-core 主管道、不升 `RULE_VERSION`、不加迁移、不改报告页**——把语义层先作为可独立验证的能力，L3-B/C 拍板后再融合进画像管道（那时才涉及快照契约与报告页）。

## 3. 数据契约（packages/shared）

```ts
/** L3 语义层输入：采集器产出（公开数据，不 clone） */
interface L3SemanticInput {
  collectedAt: string;          // ISO
  login: string;                // 主体（GitHub login）
  repos: L3RepoFiles[];
}
interface L3RepoFiles {
  owner: string;
  name: string;
  defaultBranch: string;
  language: string | null;      // repo 主语言（L0 已有）
  topics: string[];             // repo topics（L0 已有）
  description: string | null;
  starred: number;              // star 数
  fileTree: string[];           // 递归文件树路径（截断 ≤2000 条），不存内容
  readmeExcerpt: string;        // README 纯文本节选（截断 ≤16KB）
  keyFiles: Record<string, string>;  // 白名单关键文件内容（每个 ≤16KB，见 §4）
}

/** L3 语义层输出：规则版信号（纯 code + facts，不写自然语言结论） */
interface L3Signals {
  ruleVersion: string;          // SEMANTIC_RULE_VERSION
  repos: L3RepoSignal[];
  summary: {
    techStack: string[];        // 跨仓库归并的技术栈标签（去重，≤20）
    domainHints: string[];      // 领域提示标签（≤10）
  };
}
interface L3RepoSignal {
  owner: string;
  name: string;
  maturity: {
    hasTests: boolean;          // 文件树含 tests/|__tests__/|*.test.*|*.spec.*
    hasCi: boolean;             // .github/workflows|.gitlab-ci.yml|.travis.yml|.circleci/
    hasDocs: boolean;           // README 节选 ≥200 字符
    hasLicense: boolean;        // 文件树含 LICENSE*|COPYING*
    hasDockerfile: boolean;     // 文件树含 Dockerfile*|docker-compose*
    fileCount: number;          // 文件树条目数
    starBand: 'none'|'low'|'mid'|'high';  // 0 / 1-99 / 100-999 / ≥1000
  };
  techStack: string[];          // 依赖清单解析出的技术栈标签（≤20）
  repoKind: 'library'|'framework'|'tool'|'application'|'boilerplate'|'unknown';
  domainHints: string[];        // 领域提示（≤10）
}
```

契约放 `packages/shared`（单一事实源）；`EvidenceItem.layer` 已含 `'L3'`，L3-B 融合时直接复用。

## 4. 采集设计（packages/semantic-source，不 clone）

**取数通道**：官方 Octokit（复用 `@jobagent/github-source` 的 `createOctokit`，含限频退避/重试/预算；凭证只在服务端，绝不下发前端）。测试用注入 fetch 录制夹具（与 github-source 同模式）。

**采集序列（每画像 ≤8 次 REST，预算并入 NFR-1 上限）**：
1. `GET /users/{login}/repos?sort=pushed&per_page={reposN}`（默认 **5**）取最近活跃仓库；
2. 每仓库：
   - `GET /repos/{o}/{r}/git/trees/{default_branch}?recursive=1`（文件树，**截断 2000 条**；默认分支取 repo 记录 `default_branch`，404 时跳过该仓库并记 `missing:['tree']`）；
   - `GET /repos/{o}/{r}/readme`（`Accept: application/vnd.github.raw`，**截断 16KB**；404 时 `readmeExcerpt:''` 不失败）；
   - 关键文件白名单（每个 ≤16KB，命中才取，404 静默跳过）：`package.json`、`pyproject.toml`、`go.mod`、`Cargo.toml`、`requirements.txt`、`Dockerfile`、`.github/workflows/*.yml`（仅第一条）。白名单与单文件大小上限集中在 `KEY_FILE_PATTERNS` / `KEY_FILE_MAX_BYTES` 常量，可配。

**预算与降级**：单画像语义采集独立 `ProfileBudget`（默认 restCalls 60）；任一仓库失败（网络/404）**降级不失败**——只产出该仓库的 `missing` 标记，整仓采集成功但信号缺失显式标注；`not_found`（用户不存在）直接抛错（与 github-source 口径一致）。

**安全/合规**：只采集公开数据；**不存文件内容**（fileTree 只存路径、keyFiles/README 仅内存计算后丢弃，`L3SemanticInput` 只保留节选）；结论不输出敏感推断；证据可回溯（`EvidenceItem.layer='L3'`、`sourceType='file'` 契约已预留）。

## 5. 规则信号（packages/semantic-core，纯函数无 I/O）

`analyzeSemantic(input: L3SemanticInput): L3Signals`——纯函数、带版本（`SEMANTIC_RULE_VERSION`，独立于 analyzer 的 `RULE_VERSION`，**绝不升后者**，见 L3-C）。

**规则清单**：
- **工程成熟度**：文件树/README/依赖清单的直接布尔信号（见契约 `maturity`），全部可精确判定、无推断；
- **技术栈标签**：解析 `package.json.dependencies+devDependencies`、`pyproject.toml`（`[project].dependencies` + `[project.optional-dependencies]`）、`go.mod`（`require` 行）、`Cargo.toml`（`[dependencies]`），按**白名单映射**到技术栈标签（如 `react`→`react`、`next`→`nextjs`、`typescript`→`typescript`、`numpy`→`python`、`serde`→`rust`）；白名单 = `packages/shared` 技术词典的兼容子集（与 skill-extraction 共用口径，防误匹配：词边界精确匹配）；
- **领域提示**：repo `topics` 与 `description` 的关键词命中（白名单：`ai`/`machine-learning`/`devops`/`data`/`frontend`/`backend`/`blockchain` 等 ≤10 个），只输出命中的 code；
- **仓库类型**：`boilerplate`（description/topics 含 template/boilerplate/starter）> `framework`（含 framework）> `library`（含 library）> `tool`（含 cli/tool/utility）> `application`（其余有 README 的）> `unknown`。

**纪律（对齐内核散文硬约束）**：信号只出 `code + facts`，**句子一律由渲染侧按 locale 现拼**；取不到的事实不许编（缺失标记 `missing`，不是零值）；规则变更必须升 `SEMANTIC_RULE_VERSION` 并钉字面量测试。

## 6. CLI（apps/cli 新增 `semantic` 命令）

```text
jobagent semantic analyze <user> [--repos N] [--out <file>] [--format json|markdown]
```
- 默认 `--format json`（完整 `{input摘要, signals}`）；`markdown` 给可读汇报（按 locale 中文）；
- 凭证：`GITHUB_TOKEN`（与 analyze 同源，见 .env.example）；
- 依赖注入点：`source`（测试用 fake / 录制夹具），与 `analyze` 命令的 `CliDeps.source` 风格一致。

**验收**：
1. `semantic analyze <真实用户名>` 一次跑通：≤8 次 REST、输出含成熟度/技术栈/领域；
2. 用户不存在 → 明确错误（非 500 堆栈）；
3. 单仓库 404（README 缺失等）→ 该仓库缺失标记，整仓成功；
4. 纯函数 `analyzeSemantic` 对固定夹具输出逐字节稳定（钉字面量）；
5. typecheck / 单测 / build / check-migrations / `git diff --check` / 文档守护全绿。

## 7. 分期与决策点（L3-B / L3-C，2026-10-11 已全部拍板）

| 已拍板 | 内容 | 结论 |
| --- | --- | --- |
| L3-B 范围 | 是否启用 LLM 语义（README 摘要/设计决策/面试题增强） | ✅ 已拍板并落地（item150）：`--llm` 可选、fail-closed 规则回落；每画像 +1 次 LLM 调用、按决策 #21 双轨计费 |
| L3-B 配额 | demo 身份是否扣权重 | 建议仿 fusion 扣 2——**按推荐实现，属建议非决策**（当前 L3 只在 CLI 手动 `--semantic` 触发，未进 demo 在线链路，无配额影响；若后续接入在线分析再定） |
| L3-C 融合 | 语义真实性并入主画像需升 `RULE_VERSION` + 报告页新板块 + API 投影 | ✅ 已拍板并落地（item151）：`RULE_VERSION 0.8→0.9`（分级不受影响的结构性证明）；报告页「语义洞察」板块；API 投影＝semantic 属公开结构化事实，`formatProfileForViewer` 只剥面试题、semantic 天然透传 |
| 采集扩容 | reposN=5 是否够、关键文件白名单是否加 | 依赖真实数据统计（CLI 验证后决定）；`--repos` 支持 1..20 可先行覆盖 |

**L3-B/C 已由用户拍板（2026-10-11「都搞」）并全量落地**：不建表（无新增迁移）、analyzer-core 仅做结构性透传（不新增规则信号）、报告页/API 已按上表口径实现。

## 8. 与既有资产的关系

- `packages/llm`：L3-B 复用 `LlmClient` / BYOK→内置路由 / `LlmResumePolishProvider` 的 Zod 校验模式；
- `packages/claim-core`：L3-C 复用"反向核验"思路（声称 vs 证据）；
- `packages/shared` 技术词典：技术栈标签与技能提取共用口径；
- `packages/github-source`：复用 `createOctokit` 与预算/降级语义；
- 不引入新框架/中间件；不 clone（供应链安全面不变）。

## 9. 文件清单（L3-A）

```text
packages/shared/src/index.ts                 # 追加 L3SemanticInput / L3Signals 契约
packages/semantic-source/                    # 新包（octokit 采集，不 clone）
  ├─ package.json / tsconfig.json / tsconfig.build.json
  ├─ src/index.ts                            # 导出 SemanticSource / types / 常量
  ├─ src/types.ts                            # L3CollectedData / SemanticSourceOptions
  ├─ src/collector.ts                        # 采集序列 + 预算 + 降级
  └─ src/collector.test.ts                   # 注入 fetch 录制夹具
packages/semantic-core/                      # 新包（纯函数）
  ├─ package.json / tsconfig.json / tsconfig.build.json
  ├─ src/index.ts
  ├─ src/analyze.ts                          # analyzeSemantic + 规则
  └─ src/analyze.test.ts                     # 固定夹具字面量钉住
apps/cli/src/semantic-commands.ts            # semantic analyze 命令
apps/cli/src/semantic-commands.test.ts       # fake source 注入
apps/cli/src/index.ts                        # 注册 semantic 命令 + Usage
```
