/**
 * job_run_events 实体：求职任务的状态迁移审计日志（求职 Agent 阶段 1，迁移 020，设计 §5.2）。
 *
 * 只追加、不回改：run 行只留当前态，本表留可回放历史（event + from/to + actor + payload）。
 * 取值单一事实源在 `@jobagent/shared`（`JOB_RUN_EVENTS` / `JOB_RUN_ACTORS`）。
 * 与方言无关的领域类型 + 纯映射逻辑（sqlite/postgres 两套仓储共享）。
 */
import {
  JOB_RUN_ACTORS,
  JOB_RUN_EVENTS,
  JOB_RUN_STATUSES,
  type JobRunActor,
  type JobRunEventKind,
  type JobRunStatus,
} from '@jobagent/shared';
import { parseJson } from './analysis-job.js';

export type { JobRunActor, JobRunEventKind } from '@jobagent/shared';

/** 迁移事件全集（shared 为单一事实源；此处只是稳定的只读别名） */
export const JOB_RUN_EVENT_KINDS: readonly JobRunEventKind[] = JOB_RUN_EVENTS;

/** 迁移动作者（shared 为单一事实源；此处只是再导出，命名与契约一致） */
export { JOB_RUN_ACTORS };

/**
 * 结构化载荷：只存可 JSON 往返的标量，渲染侧按 key 取值，不塞嵌套对象
 * （嵌套会让"payload 里到底有什么"失去契约；需要多字段就多开 key）。
 */
export type JobRunEventPayload = Record<string, string | number | boolean | null>;

export interface StoredJobRunEvent {
  id: string;
  /** 归属任务（job_runs.id） */
  runId: string;
  event: JobRunEventKind;
  /** 迁移前状态；任务的首个事件为 null */
  fromStatus: JobRunStatus | null;
  /** 迁移后状态 */
  toStatus: JobRunStatus;
  actor: JobRunActor;
  payload: JobRunEventPayload;
  createdAt: string;
}

export interface NewJobRunEvent {
  /** 由调用方生成：`evt-<uuid>` */
  id: string;
  runId: string;
  event: JobRunEventKind;
  /** 首个事件传 null/缺省 */
  fromStatus?: JobRunStatus | null;
  toStatus: JobRunStatus;
  actor: JobRunActor;
  /** 缺省落库为 '{}' */
  payload?: JobRunEventPayload;
  /** 追加时刻（UTC ISO8601），由调用方给出以保证与 run 行同刻 */
  createdAt: string;
}

/** Drizzle 查询返回的原始行（camelCase）；payload 为 JSON 文本 */
export interface RawJobRunEventRow {
  id: string;
  runId: string;
  event: string;
  fromStatus: string | null;
  toStatus: string;
  actor: string;
  payload: string;
  createdAt: string;
}

function isPayloadValue(value: unknown): value is string | number | boolean | null {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  );
}

/** JSON 文本 → 载荷对象：非对象、解析失败或含非标量值一律按 key 逐个丢弃 */
function parsePayload(raw: string | null): JobRunEventPayload {
  const parsed = parseJson<unknown>(raw);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
  const out: JobRunEventPayload = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (isPayloadValue(value)) out[key] = value;
  }
  return out;
}

function toRunStatus(raw: string): JobRunStatus | null {
  return (JOB_RUN_STATUSES as readonly string[]).includes(raw) ? (raw as JobRunStatus) : null;
}

/**
 * Drizzle 行 → 领域对象（纯函数，双方言共用）。
 * 未知取值一律回退到**不会伪装成成功**的一侧：事件回退 'fail'、actor 回退 'system'
 * （不把来路不明的变更记到用户头上）、toStatus 回退 'failed'、fromStatus 回退 null。
 * 这样审计流里出现未知值时，读出来的是一处显式失败，而不是一段看似正常的推进。
 */
export function toStoredJobRunEvent(row: RawJobRunEventRow): StoredJobRunEvent {
  const event = (JOB_RUN_EVENT_KINDS as readonly string[]).includes(row.event)
    ? (row.event as JobRunEventKind)
    : 'fail';
  const actor = (JOB_RUN_ACTORS as readonly string[]).includes(row.actor)
    ? (row.actor as JobRunActor)
    : 'system';
  return {
    id: row.id,
    runId: row.runId,
    event,
    fromStatus: row.fromStatus ? toRunStatus(row.fromStatus) : null,
    toStatus: toRunStatus(row.toStatus) ?? 'failed',
    actor,
    payload: parsePayload(row.payload),
    createdAt: row.createdAt,
  };
}
