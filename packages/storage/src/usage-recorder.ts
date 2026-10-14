import { randomUUID } from 'node:crypto';
import type { RecordUsageInput } from '@jobagent/shared';
import type { UsageEventRecord } from './entities/usage-event.js';
import type { IUsageEventsRepository } from './repositories/usage-events.js';

/**
 * 用量计量 recorder——业务侧埋点的唯一入口（决策 #25 ④ Wave A）。
 *
 * 硬纪律（fail-open）：计量**绝不能打断产品主链路**。record() 内部生成 id 与
 * created_at 并落库，任何错误（含仓储同步抛出）只 console.error，永不向外抛；
 * 调用方也不需要 await 失败分支（await 仅为把落库排在请求生命周期内）。
 */
export interface UsageRecorder {
  /** 追加一条用量事件；永不拒绝（fail-open，失败只记日志）。 */
  record(input: RecordUsageInput): Promise<void>;
}

/**
 * 真实 recorder：id 用 `usg-<uuid>`（参考 job_run_events 的 evt- 主键惯例），
 * created_at 注入 UTC ISO8601；可选字段缺省归一为 null。
 */
export function createUsageRecorder(repo: IUsageEventsRepository): UsageRecorder {
  return {
    async record(input: RecordUsageInput): Promise<void> {
      try {
        const row: UsageEventRecord = {
          id: `usg-${randomUUID()}`,
          accountId: input.accountId ?? null,
          category: input.category,
          feature: input.feature,
          billingSource: input.billingSource,
          provider: input.provider ?? null,
          model: input.model ?? null,
          promptTokens: input.promptTokens ?? null,
          completionTokens: input.completionTokens ?? null,
          quantity: input.quantity ?? null,
          createdAt: new Date().toISOString(),
        };
        await repo.insert(row);
      } catch (err) {
        // fail-open：计量失败只进服务端日志，绝不冒泡打断主链路。
        console.error(
          '[usage] failed to record usage event:',
          JSON.stringify({
            category: input.category,
            feature: input.feature,
            billingSource: input.billingSource,
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      }
    },
  };
}

/** 空 recorder（测试/缺省装配用）：所有方法 no-op，同样永不抛出。 */
export function createNullUsageRecorder(): UsageRecorder {
  return {
    async record(): Promise<void> {},
  };
}
