/**
 * cron_heartbeat 实体：cron 消费通道的存活信号（deferred「Cron Worker 的失败信号
 * 没有任何读者」）。
 *
 * 一条记录对应一个消费方（process-job / agent-tick），由 API cron 端点在每次
 * 尝试后 upsert：
 * - 成功：last_success_at + last_result 更新、last_error 清空（最近一次无失败）；
 * - 失败：last_error 更新、updated_at 刷新，last_success_at/last_result 保留
 *   （读口需要同时看到"最后一次成功是什么时候"与"最近一次是否失败"）。
 * last_success_at 为 NULL 表示该消费方从未成功过。
 */
export interface StoredCronHeartbeat {
  /** 消费方标识：process-job | agent-tick */
  consumer: string;
  /** 最近一次成功时刻（UTC ISO8601）；从未成功则为 null */
  lastSuccessAt: string | null;
  /** 最近一次成功的简短结果（如 idle / processed=<jobId> / advanced=<n>） */
  lastResult: string | null;
  /** 最近一次失败的错误信息；最近一次尝试成功则为 null */
  lastError: string | null;
  updatedAt: string;
}

/** Drizzle 查询返回的原始行（camelCase），两方言结构一致 */
export interface RawCronHeartbeatRow {
  consumer: string;
  lastSuccessAt: string | null;
  lastResult: string | null;
  lastError: string | null;
  updatedAt: string;
}

export function toStoredCronHeartbeat(row: RawCronHeartbeatRow): StoredCronHeartbeat {
  return {
    consumer: row.consumer,
    lastSuccessAt: row.lastSuccessAt,
    lastResult: row.lastResult,
    lastError: row.lastError,
    updatedAt: row.updatedAt,
  };
}
