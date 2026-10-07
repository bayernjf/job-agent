/**
 * cron_heartbeat 仓储契约——cron 消费通道的存活信号。
 *
 * 写口只有 API cron 端点（process-job / agent-tick 每次尝试后 upsert）；
 * 读口是 /health?deep=1（与未来的报告页 /my）。不自动清理：
 * 行数恒等于消费方数量（两个），保留成本为零。
 */
import type { StoredCronHeartbeat } from '../entities/index.js';

export interface ICronHeartbeatRepository {
  /** 成功消费回写（幂等 upsert；清空 last_error） */
  recordSuccess(consumer: string, atIso: string, result: string): Promise<void>;
  /** 失败回写（保留最后一次成功信息供读口对照，另记 last_error） */
  recordFailure(consumer: string, atIso: string, error: string): Promise<void>;
  /** 全部心跳行（读口用；按 consumer 升序） */
  listAll(): Promise<StoredCronHeartbeat[]>;
}
