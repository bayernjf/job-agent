import type {
  AnalyzedLogin,
  DemoRateKind,
  DemoSlotResult,
  NewDemoSession,
  StoredDemoSession,
} from '../entities/index.js';

/**
 * demo_sessions / demo_rate_events 仓储契约（演示模式），业务模块只依赖此接口。
 *
 * 关键约束（design-demo-mode-20260915 §3.1）：
 * - acquireAnalyzeSlot 必须是单条条件 UPDATE 的原子扣减，严禁 select-then-update；
 * - 所有读写"自己会话"的方法都以 sessionId 作为必填 WHERE 条件（越权防护）。
 */
export interface IDemoSessionsRepository {
  create(session: NewDemoSession): Promise<void>;
  /** Active 且未过期才返回；status=exited/过期/不存在返回 undefined */
  getActive(id: string, now: string): Promise<StoredDemoSession | undefined>;
  /**
   * 原子名额扣减：单条条件 UPDATE，看影响行判定是否拿到名额。
   * cost 为本次作业扣减的配额权重（默认 1；platform=all 双源融合约 2x 成本，传 2）。
   * 剩余额度不足 cost 时整单拒绝（影响 0 行、不部分扣减），返回 quota_exceeded。
   */
  acquireAnalyzeSlot(id: string, quota: number, now: string, cost?: number): Promise<DemoSlotResult>;
  /** 仅用于"扣名额成功但 jobs.create 失败"的补偿，按原 cost 回退；正常分析失败不回补 */
  releaseAnalyzeSlot(id: string, cost?: number): Promise<void>;
  /** match 计数 +1（仅观测，默认无硬配额） */
  incrementMatch(id: string, now: string): Promise<void>;
  /** 刷新 last_seen_at，并可选追加 analyzed_logins（去重、保留最近 20 条） */
  touch(id: string, now: string, login?: AnalyzedLogin): Promise<void>;
  /** 置 exited（主动退出演示） */
  exit(id: string, now: string): Promise<void>;

  // ── IP 滑动窗口（§3.2）──
  /** 统计某 IP 某桶在 since 之后的事件数 */
  countRateEvents(ipHash: string, kind: DemoRateKind, since: string): Promise<number>;
  /** 动作成立后追加一条限流事件 */
  insertRateEvent(ipHash: string, kind: DemoRateKind, now: string): Promise<void>;

  // ── CLI cleanup（§11）──
  /** 删除 exited 超保留期、或已过期超保留期的会话，返回删除行数 */
  purgeExpired(now: string, retainMs: number): Promise<number>;
  /** 删除 created_at 早于 cutoff 的限流事件，返回删除行数 */
  purgeRateEventsBefore(cutoff: string): Promise<number>;
}
