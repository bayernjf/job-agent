import {
  JOB_RUN_EVENTS,
  JOB_RUN_STATUSES,
  type JobRunEventKind,
  type JobRunStatus,
} from '@jobagent/shared';

/**
 * 求职任务（JobRun）状态机（设计 §5.2）。
 *
 * 纯函数、零 I/O：只回答「当前状态 + 事件 → 允许落到哪个状态」。
 * 编排壳（apps/api 的 agent runner / cron 端点）负责把结果写库与落审计事件；
 * 状态是否允许写入由存储层的 `compareAndSetStatus` 原子条件更新兜底，
 * 两者分工：内核给语义，存储给并发安全。
 *
 * 阶段 1（求职工作台）实际路径：
 *   created → configured → watching → recommending → awaiting_approval → tracking
 *   （无合格项时 watching/recommending --rescan--> watching；用户中止 --cancel--> cancelled）
 * `submitting` / `submitted` 是阶段 2（扩展执行投递）才使用的状态，此处先固化迁移，
 * 避免阶段 2 再改状态机取值。
 */

/** 迁移动作者：user=用户点击、agent=Agent 一轮、system=cron/运维。 */
export type JobRunTransitionActor = 'user' | 'agent' | 'system';

export type JobRunTransitionTable = Readonly<
  Record<JobRunStatus, Partial<Record<JobRunEventKind, JobRunStatus>>>
>;

/**
 * 迁移表。终态（archived/cancelled/failed）没有出边——终态不可复活，
 * 需要再来一轮就新建任务，这样审计日志永远是线性可回放的。
 */
export const JOB_RUN_TRANSITIONS: JobRunTransitionTable = {
  created: { validate: 'configured', fail: 'failed', cancel: 'cancelled' },
  configured: { start: 'watching', fail: 'failed', cancel: 'cancelled' },
  watching: {
    candidates_ready: 'recommending',
    // 本轮没扫到合格岗位：留在 watching 等下一轮（不是失败）
    rescan: 'watching',
    fail: 'failed',
    cancel: 'cancelled',
  },
  recommending: {
    generated: 'awaiting_approval',
    // 生成阶段发现候选全被质量闸/生成失败挡掉：退回 watching
    rescan: 'watching',
    fail: 'failed',
    cancel: 'cancelled',
  },
  awaiting_approval: {
    // 阶段 1：确认只是把票据置 approved，任务仍停在人机闸上（可能还有其它待投项）
    approve: 'awaiting_approval',
    // 用户拒绝最后一个待投项且无已确认项：回 watching 等下一轮
    reject: 'watching',
    // 阶段 1：用户标记「已投」（票据置 submitted）→ 进入跟踪
    submitted: 'tracking',
    rescan: 'watching',
    fail: 'failed',
    cancel: 'cancelled',
  },
  submitting: { submitted: 'submitted', fail: 'failed', cancel: 'cancelled' },
  submitted: { track: 'tracking', fail: 'failed', cancel: 'cancelled' },
  tracking: { archive: 'archived', fail: 'failed', cancel: 'cancelled' },
  archived: {},
  cancelled: {},
  failed: {},
};

export type TransitionResult =
  | { ok: true; event: JobRunEventKind; from: JobRunStatus; to: JobRunStatus }
  | { ok: false; event: JobRunEventKind; from: JobRunStatus; reason: 'unknown_status' | 'not_allowed' };

const STATUS_SET: ReadonlySet<string> = new Set(JOB_RUN_STATUSES);
const EVENT_SET: ReadonlySet<string> = new Set(JOB_RUN_EVENTS);

/** 判断某个状态是否接受某个事件；不合法时给出原因（供 API 映射 409）。 */
export function planTransition(status: JobRunStatus, event: JobRunEventKind): TransitionResult {
  if (!STATUS_SET.has(status) || !EVENT_SET.has(event)) {
    return { ok: false, event, from: status, reason: 'unknown_status' };
  }
  const to = JOB_RUN_TRANSITIONS[status][event];
  if (!to) return { ok: false, event, from: status, reason: 'not_allowed' };
  return { ok: true, event, from: status, to };
}

/** 终态：不再接受任何事件（要重来就新建任务）。 */
export const TERMINAL_JOB_RUN_STATUSES: readonly JobRunStatus[] = ['archived', 'cancelled', 'failed'];

export function isTerminalStatus(status: JobRunStatus): boolean {
  return TERMINAL_JOB_RUN_STATUSES.includes(status);
}

/** 用户可随时中止的状态（terminal 之外的全部）。 */
export function canCancel(status: JobRunStatus): boolean {
  return planTransition(status, 'cancel').ok;
}

/** 编排壳用它决定「这个任务还能不能被 tick 推进」。 */
export function isScannableStatus(status: JobRunStatus): boolean {
  return status === 'configured' || status === 'watching' || status === 'recommending';
}
