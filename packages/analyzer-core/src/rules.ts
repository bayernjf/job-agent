/**
 * 规则版本与信号码常量。
 * 规则版本化保证同一输入 → 同一输出（可复现）；信号码带版本前缀。
 */

/** 分析引擎规则版本（analyzerVersion = `${SCHEMA_VERSION}-${ruleVersion}`） */
export const RULE_VERSION = '0.1';

/** 真实性信号码（前缀 r0.1 表明归属规则版本；severity 见 shared 契约） */
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
} as const;

export type SignalCode = (typeof SIGNAL_CODES)[keyof typeof SIGNAL_CODES];
