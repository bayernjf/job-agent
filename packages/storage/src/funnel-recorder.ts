import { randomUUID } from 'node:crypto';
import type { RecordFunnelInput } from '@jobagent/shared';
import type { FunnelEventRecord } from './entities/funnel-event.js';
import type { IFunnelEventsRepository } from './repositories/funnel-events.js';

/** 报告查看 30 分钟 (session, profile) 去重窗口（design-funnel-analytics-20261015 §5.1） */
export const FUNNEL_VIEW_DEDUPE_WINDOW_MS = 30 * 60 * 1000;

/**
 * 验证漏斗 recorder——埋点写入的唯一入口（PRD §11.2 / NFR-7，迁移 040）。
 *
 * 硬纪律（fail-open，与 usage recorder 同一模式）：埋点**绝不能打断产品主链路**。
 * record()/recordView() 内部生成 id 与 created_at 并落库，任何错误只 console.error，
 * 永不向外抛；调用方不需要 await 失败分支。
 *
 * 隐私硬约束：本结构没有账号 id / IP / 被分析用户名 / UA 字段，session 串联只用
 * 24h 随机 ja_sid（见 shared funnel.ts 头注）。
 */
export interface FunnelRecorder {
  /** 追加一条漏斗事件；永不拒绝（fail-open，失败只记日志）。 */
  record(input: RecordFunnelInput): Promise<void>;
  /**
   * 报告查看写入：同一 (sessionRef, profileId) 在 30 分钟窗口内已有 report_viewed
   * 则跳过（fail-open；仓储去重失败时退化为直插，宁可多记不可阻断渲染）。
   */
  recordView(input: RecordFunnelInput): Promise<void>;
}

/**
 * 真实 recorder：id 用 `fe-<uuid>`（参考 usage recorder 的 usg- 惯例），
 * created_at 注入 UTC ISO8601；可选字段缺省归一为 null。
 */
export function createFunnelRecorder(repo: IFunnelEventsRepository): FunnelRecorder {
  const toRow = (input: RecordFunnelInput): FunnelEventRecord => ({
    id: `fe-${randomUUID()}`,
    event: input.event,
    sessionRef: input.sessionRef ?? null,
    profileId: input.profileId ?? null,
    requester: input.requester ?? null,
    createdAt: new Date().toISOString(),
  });
  return {
    async record(input: RecordFunnelInput): Promise<void> {
      try {
        await repo.insert(toRow(input));
      } catch (err) {
        // fail-open：埋点失败只进服务端日志，绝不冒泡打断主链路。
        console.error(
          '[funnel] failed to record funnel event:',
          JSON.stringify({
            event: input.event,
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      }
    },
    async recordView(input: RecordFunnelInput): Promise<void> {
      try {
        await repo.recordView(toRow(input), FUNNEL_VIEW_DEDUPE_WINDOW_MS);
      } catch (err) {
        // fail-open：去重查询失败时退化为直插（宁多记不漏记），错误仍只记日志。
        console.error(
          '[funnel] failed to record report view:',
          JSON.stringify({
            error: err instanceof Error ? err.message : String(err),
          }),
        );
        try {
          await repo.insert(toRow(input));
        } catch (fallbackErr) {
          console.error(
            '[funnel] failed to record report view (fallback):',
            JSON.stringify({
              error: fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr),
            }),
          );
        }
      }
    },
  };
}

/** 空 recorder（测试/缺省装配用）：所有方法 no-op，同样永不抛出。 */
export function createNullFunnelRecorder(): FunnelRecorder {
  return {
    async record(): Promise<void> {},
    async recordView(): Promise<void> {},
  };
}
