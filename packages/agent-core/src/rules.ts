/**
 * 求职 Agent 内核的规则版本（设计 docs/设计-求职Agent-20261002.md）。
 *
 * 与 analyzer-core 的 RULE_VERSION / resume-core 的 RESUME_RULE_VERSION 同一条纪律：
 * 影响选择、排序、质量闸或报告结构的变更必须递增本版本；仅修注释/重命名不递增。
 * 阶段 1（求职工作台）只做「Agent 准备、人执行」，故内核里没有任何投递副作用。
 */
export const AGENT_RULE_VERSION = '0.1';

/** 一轮扫描最多产出多少条待投票据（对齐设计判据「打开页面看到 10 个匹配岗位」）。 */
export const DEFAULT_CANDIDATE_LIMIT = 10;

/** 单条匹配报告最多列几个「岗位提到、画像没证据」的缺口（防报告刷屏）。 */
export const DEFAULT_MAX_GAPS = 5;

/** 每源每日投递上限的缺省值（设计 §3.4；偏好里可覆盖）。 */
export const DEFAULT_DAILY_SUBMIT_LIMIT = 20;
