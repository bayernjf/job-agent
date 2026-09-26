/**
 * 规则版本与信号码常量。
 * 规则版本化保证同一输入 → 同一输出（可复现）；信号码带版本前缀。
 */

/**
 * 分析引擎规则版本（analyzerVersion = `${SCHEMA_VERSION}-${ruleVersion}`）。
 * 0.6（2026-09-26，T10）：`improvementSuggestions` 每条新增稳定 `code`，文案改由
 * `shared` 的 `composeImprovementSuggestion(code, locale)` 现拼（快照里仍存按 'en'
 * 拼出的数据层原句）。分级同样不受影响：`signals.ts` 自 `be07ab6` 起仍逐字节未变。
 * 0.5（2026-09-25，#18 批次 6）：新增 `improvementSuggestions` 生产者（T09，
 * `suggestions.ts` 两条保守规则、每条必挂真实证据）——画像输出新增可选字段。
 * **分级不受影响的结构性证明**：`signals.ts` 自 0.3 代码态 `be07ab6` 起仍逐字节未变，
 * T09 只新增文件与 `profile.ts` 装配一行，分级路径读不到它；0.4 的实跑校准结论由此继承。
 * 0.4（2026-09-25，#18 批次 1）：**画像输出实际已变**——技能目录新增 19 条 AI/Agent
 * framework 词条、framework 上限 8→10、新增 topics 兜底标签生产者（T04/T05）、
 * headline 改为平台正确且不带 login（T07）。
 * 版本必须与行为一致，否则同一 analyzerVersion 会对应两套输出、缓存与分享链接失去可复现性；
 * 信号码是字面量常量、不由本版本派生，故旧快照不受影响。
 * ✅ T08 双向零误伤回归已通过（2026-09-25 实跑，26/26 采集成功）：22 个正样本无一被降为
 * suspicious、4 个负样本无一升为 likely_authentic；Gitee 可解析的 9 个账号状态与 0.3 基线逐条一致。
 * 另有 3 处状态漂移（kentcdodds、wycats 因 `external_contributions` 随采样窗口来回出现/消失，
 * MSNightmare 转为 `empty_activity`→insufficient_data）。**归因是证明而非推测**：相对 0.3 代码态
 * 提交 `be07ab6`，分级器 `signals.ts` 与喂它的 `github-source` collector/graphql/rest **逐字节未变**，
 * 本批改动的只有技能标签/目录、activity 计数、headline 文案、PR 证据 claim 文本与三个 diff 字段的
 * 类型放宽；而 `signals.ts` 对这些表面零引用（`.claim`/`skillTag`/`metrics.`/`additions`/`headline`
 * 全部 0 命中）。代码不能让分级变化，剩下只能是线上数据变了。
 * 结论：0.4 可上线。
 */
export const RULE_VERSION = '0.6';

/**
 * 真实性信号码。规则 0.1 遗留信号在 0.2/0.3 中逻辑未变，保留 r0.1 前缀以避免快照漂移；
 * 规则 0.2 新增信号使用 r0.2 前缀。severity 见 shared 契约。
 */
export const SIGNAL_CODES = {
  /** 提交 author 与账号身份不一致（name 相似度低 / 邮箱不匹配） */
  AUTHOR_INCONSISTENCY: 'r0.1.sig.author_inconsistency',
  /** 提交在短窗口内爆发且前后长期沉默（搬运/批量灌水特征） */
  COMMIT_BURST: 'r0.1.sig.commit_burst',
  /** 长期无活动（最近推送超过 12 个月） */
  STALE_ACTIVITY: 'r0.1.sig.stale_activity',
  /** 高 star 与低活跃不匹配（star 可能是搬运/灌水来源） */
  STAR_ACTIVITY_MISMATCH: 'r0.1.sig.star_activity_mismatch',
  /** 几乎没有行为证据，无法下真实性结论 */
  EMPTY_ACTIVITY: 'r0.1.sig.empty_activity',
  /** 活动跨度过短（不足 6 个月） */
  SHORT_LONGEVITY: 'r0.1.sig.short_longevity',
  /** 有被他人项目 merge 的贡献（正向信号，按数量分级：1-2 弱正向，3+ 强正向） */
  EXTERNAL_CONTRIBUTIONS: 'r0.1.sig.external_contributions',
  /** 语言/领域单一（弱信号，仅信息提示） */
  LOW_DIVERSITY: 'r0.1.sig.low_diversity',
  /** star 与 commit 比例异常（star 远多于 commit，可能是买 star 或搬运项目） */
  STAR_TO_COMMIT_RATIO: 'r0.1.sig.star_to_commit_ratio',
  /** PR 几乎全在自己 repo（可能是刷 PR 数量） */
  SELF_PR_RATIO: 'r0.1.sig.self_pr_ratio',
  /** 行为高度集中在单一仓库且缺乏协作痕迹（规则 0.2 新增，方案 B；封顶 warn） */
  NARROW_ACTIVITY_SCOPE: 'r0.2.sig.narrow_activity_scope',
} as const;

export type SignalCode = (typeof SIGNAL_CODES)[keyof typeof SIGNAL_CODES];
