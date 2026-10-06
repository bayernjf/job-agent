/**
 * job_runs 实体：求职任务状态机实例（求职 Agent 阶段 1，迁移 019，设计 §5.2）。
 *
 * 状态全集与事件全集的单一事实源在 `@jobagent/shared`（`JOB_RUN_STATUSES` /
 * `JOB_RUN_EVENTS` / `JOB_RUN_ACTORS`）；本层只再导出其类型与"DB 写入校验用"的数组，
 * 不重复定义一套取值。状态机变迁由仓储的条件 UPDATE（compareAndSetStatus）串行化，
 * 每条变迁另落一条 job_run_events（020）以便回放。
 * 与方言无关的领域类型 + 纯映射逻辑（sqlite/postgres 两套仓储共享）。
 */
import { JOB_RUN_STATUSES, type JobRunStatus } from '@jobagent/shared';

export type { JobRunStatus } from '@jobagent/shared';

/** DB 合法状态值（shared 为单一事实源，此处只是稳定的只读别名） */
export const JOB_RUN_STATUSES_DB: readonly JobRunStatus[] = JOB_RUN_STATUSES;

export interface StoredJobRun {
  id: string;
  /** 归属账号（accounts.id） */
  accountId: string;
  /** 打分所用画像快照（profiles.id） */
  profileId: string;
  /** 绑定的偏好集（job_preferences.id） */
  preferenceId: string;
  status: JobRunStatus;
  /** 本轮扫描尝试次数 */
  attempts: number;
  /** 显式失败原因；健康时为 null */
  lastError: string | null;
  /** 上次扫描完成时间（UTC ISO8601）；null = 从未扫描（调度游标） */
  lastScanAt: string | null;
  /** 拥有者上次查看该 run 的时间（UTC ISO8601）；null = 从未查看（未读批次信号） */
  lastViewedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 入库输入：新任务一律从 'created' 起步（状态只能经事件推进） */
export interface NewJobRun {
  /** 由调用方生成：`run-<uuid>` */
  id: string;
  accountId: string;
  profileId: string;
  preferenceId: string;
  createdAt: string;
}

/** 状态推进补丁：status 必填（推进总是显式给出目标态），updatedAt 由调用方给出 */
export interface JobRunStatusPatch {
  status: JobRunStatus;
  attempts?: number;
  lastError?: string | null;
  lastScanAt?: string | null;
  updatedAt: string;
}

/** Drizzle 查询返回的原始行（camelCase），两方言结构一致 */
export interface RawJobRunRow {
  id: string;
  accountId: string;
  profileId: string;
  preferenceId: string;
  status: string;
  attempts: number;
  lastError: string | null;
  lastScanAt: string | null;
  lastViewedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Drizzle 行 → 领域对象（纯函数，双方言共用）；未知状态回退 'failed'（禁止"看似成功"） */
export function toStoredJobRun(row: RawJobRunRow): StoredJobRun {
  const status = (JOB_RUN_STATUSES_DB as readonly string[]).includes(row.status)
    ? (row.status as JobRunStatus)
    : 'failed';
  return {
    id: row.id,
    accountId: row.accountId,
    profileId: row.profileId,
    preferenceId: row.preferenceId,
    status,
    attempts: row.attempts,
    lastError: row.lastError ?? null,
    lastScanAt: row.lastScanAt ?? null,
    lastViewedAt: row.lastViewedAt ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
