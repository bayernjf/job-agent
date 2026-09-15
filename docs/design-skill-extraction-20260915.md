# 技能标签精确提取设计（B-4）

> 日期：2026-09-15　状态：现行　范围：仅 `packages/analyzer-core`，不改 shared 契约、不改真实性信号与规则版本。
> 关联：item12 第一档缓做项「缺失技能精确提取」；`computeSkillTags` 现状见 `packages/analyzer-core/src/skills.ts`。

## 1. 背景与问题

现有 `computeSkillTags`：

- **language**：按 `repo.primaryLanguage` 聚合，证据/深度逻辑已合理，**本次不动**。
- **framework / domain**：仅用 13 个框架词、7 个领域词的**子串正则**去撞 `repo.name + description + topics`。

三个问题：

1. **词典太窄**：数据库（Postgres/Redis/Mongo）、DevOps/云（Docker/K8s/Terraform/AWS）、构建测试工具（Vite/Jest/Playwright）、后端框架（NestJS/Fastify/Gin/Flask）等招聘高频技术全部漏识别。
2. **信号源没用全**：`commits.messageHeadline`、`pullRequests.title` 是"真的在用某技术"的强行为信号，目前完全没参与。
3. **子串误匹配**：`/express/i` 会命中 "expression"、`/react/i` 会命中 "reactive"，缺少词边界与别名归一。

## 2. 目标 / 非目标

**目标**

- 在不改 `SkillTag` 契约（kind 仍为 `language|framework|domain`）、不改真实性内核的前提下，让 framework 标签覆盖招聘高频技术栈，并从 topics / description / 仓库名 / commit 标题 / PR 标题多信号提取，带词边界防误匹配、带可回溯证据。
- 纯函数、确定性、就近单测；标签必挂真实存在的 `evidenceRefs`（无证据不下结论）。

**非目标（继续缓做）**

- 不 clone 仓库、不解析依赖清单（package.json / go.mod）——那是 L2。
- 不新增 `SkillTagKind`（如 database/devops），避免动 shared schema、匹配引擎与前端分组；数据库/工具/云统一归 `framework`（"具体技术"），领域大类仍归 `domain`。
- 不做技能熟练度年资估算、不做 LLM 抽取。
- 不改 language 标签、不改 `RULE_VERSION`（技能标签不是真实性信号）。

## 3. 信号源与权重

| 信号源 | 字段 | 强度 | 匹配方式 |
| --- | --- | --- | --- |
| 仓库 topics | `repo.topics[]` | 最强（作者自标注的干净 token） | 小写**精确相等**（不走正则） |
| 仓库描述 | `repo.description` | 中 | 词边界正则 |
| 仓库名 | `repo.name` | 中（kebab 名常含技术，如 `nextjs-blog`） | 词边界正则（kebab 的 `-` 视为边界） |
| commit 标题 | `commits[].messageHeadline` | 中（行为佐证） | 词边界正则 |
| PR 标题 | `pullRequests[].title` | 中（行为佐证） | 词边界正则 |

> topics 是平台结构化标签，直接 `topic.toLowerCase() === alias` 即命中，避免正则误伤；自由文本（description/name/commit/PR）统一走词边界正则。

## 4. 技术词典（新文件 `skills-catalog.ts`）

```ts
interface SkillEntry {
  /** 输出标签名（小写、规范名） */
  name: string;
  /** 命中别名（全部小写）；name 本身也是别名之一 */
  aliases: string[];
  kind: 'framework' | 'domain';
}
```

- **framework（具体技术，招聘可直接匹配岗位）**，分组：
  - 前端：react（reactjs）、vue（vuejs）、angular、svelte、next.js（nextjs/next js）、nuxt（nuxtjs）、astro、remix、tailwind、vite、webpack、rollup、jest、vitest、playwright、cypress、redux
  - 后端：express、koa、nestjs、fastify、hono、fastapi、django、flask、spring（spring boot）、rails、gin
  - 数据/存储：postgresql（postgres/pg）、mysql、sqlite、redis、mongodb、elasticsearch、kafka、drizzle、prisma、typeorm
  - DevOps/云/工具：docker、kubernetes（k8s）、terraform、aws、gcp、azure、github actions、nginx、grafana、prometheus
  - 移动/客户端：flutter、react native、android、ios、electron
- **domain（领域大类，保留现有 7 个并词边界化）**：frontend、backend、data-ml、devops、mobile、blockchain、game。
- 刻意**不放** TypeScript/Python/Go/Java 等已由 `primaryLanguage` 覆盖的语言，避免与 language 标签重复；`node.js` 作为运行时保留（primaryLanguage 只会给 JavaScript）。
- 词典为单一事实源、纯数据，扩充只改这一个文件。

### 词边界与别名

- 自由文本匹配：把条目别名 escape 后拼成 `\b(?:a1|a2|...)\b`，`i` 不敏感；对含 `.`/空格/`-` 的别名（`next.js`、`react native`、`github actions`、`k8s`）同样适用（`\b` 在字母数字边界生效，`8s` 数字也满足）。
- kebab 仓库名：匹配前把 `-`/`_` 当成分隔，`nextjs-blog` 中 `nextjs` 能被 `\bnextjs\b` 命中。
- 别名归一保证 `k8s`/`kubernetes`、`pg`/`postgres`/`postgresql` 输出同一个规范名，不产生重复标签。

## 5. 聚合、深度与置信度

对每个命中的 `SkillEntry` 聚合：

- `repoHits: Set<owner/name>`：在该仓 topics/description/name 命中；
- `topicRepos`：其中经 topics 命中的仓（强信号子集）；
- `behaviorHits: number`：commit/PR 标题命中条数；
- `evidenceRefs`：repo 命中挂 `repo:owner/name`（最多 3 个），行为命中挂对应 `commit:repo:oid` / `pr:repo:num`（最多补 2 个），全部必须在 `input.evidence` 的 known 集合内，否则丢弃该 ref；最终 refs 非空才产出标签。

**depth**

- `proficient`：命中 ≥2 个不同仓；或 topics 命中且有 ≥1 条 commit/PR 行为佐证；或行为命中 ≥3 条。
- 否则 `used`。

**confidence（clamp 0.30–0.85）**

- 基线 0.40；topics 命中 +0.15；每多一个命中仓 +0.06；有行为佐证 +0.10。
- domain 类沿用更保守上限 0.70（领域是推断、不如具体技术硬）。

排序：confidence 降序；framework 取 top 8（原 4，词典扩充后放宽），domain 取 top 4（不变）。language 段逻辑与排序、slice(6) 不变。

## 6. 缺失与降级

- 某条目只在自由文本命中但对应 evidence 不在 known 集合（理论上不会，repo 都有证据）→ 不产出，宁可不报。
- repos 为空 → 返回 `[]`（保持现有测试语义）。
- commit/PR 缺失（Gitee 薄证据账号可能为空）→ 仅靠 repo 信号，不报错、不补默认。

## 7. 测试点（`skills.test.ts` 就近扩充）

1. 现有断言不破：TypeScript proficient、Go used、framework 含 react/hono、domain 含 backend/data-ml、空仓返回 `[]`、refs 全部合法。
2. 词边界防误匹配：description 含 "expression" 不产出 express、含 "reactive" 不产出 react。
3. 别名归一：topics `k8s` 输出规范名 `kubernetes`；`pg`/`postgres` 合并为 `postgresql` 且只一条。
4. 行为信号：仅 commit/PR 标题提到 redis（repo 文本无 redis）也能产出 redis，且 refs 挂 `commit:`/`pr:` 证据。
5. 深度：两仓命中 → proficient；仅一仓 description 弱命中 → used。
6. 不重复：primaryLanguage 已给 TypeScript 时，framework 不再产出 typescript。

## 8. 原子提交规划

1. `feat(analyzer)`：新增 skills-catalog 词典 + 重写 skills.ts framework/domain 提取（多信号/词边界/别名/证据），扩充 skills.test.ts。
2. `docs`：本设计文档 + docs/README 场景入口 + AGENTS 必要行 + handoff 回写。

全仓 `typecheck/test/build`、`git diff --check` 全绿后提交，**不 push**（用户自行 push）。
