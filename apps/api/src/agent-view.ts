import type {
  JobPreferences,
  JobRun,
  JobRunEvent,
  SubmitIntent,
  SubmitIntentJob,
} from '@jobagent/shared';
import type {
  StoredJobPreference,
  StoredJobRun,
  StoredJobRunEvent,
  StoredSubmitIntent,
} from '@jobagent/storage';
import { knownSources } from '@jobagent/agent-core';
import type { AgentRunViewData } from './agent-runner.js';

/**
 * 存储行 → 对外契约的投影（求职工作台）。
 *
 * 为什么需要这一层：`@jobagent/storage` 的实体按仓库惯例把主键叫 `id`
 * （profiles/applications/interviews 都是），而 `@jobagent/shared` 的求职 Agent 契约
 * 用 `preferenceId` / `runId` / `eventId` / `intentId` 表明"这是哪一类 id"，前端与
 * 文档都以契约为准。两者只在**这一处**做显式映射，业务代码不必记住两套名字。
 *
 * 投影是纯函数、只做改字段名与收敛枚举，不改数值、不补事实：
 *   - `sources` 从 TEXT 里的任意字符串收敛成已知 `JobSource`（未知值丢弃，与写入口径一致）；
 *   - `applicationId` / `jobSource` 等存储侧附加字段在契约里没有，投影时原样带出（只增不减语义）。
 */

export function toPreferenceView(preference: StoredJobPreference): JobPreferences {
  const { id, sources, ...rest } = preference;
  return { ...rest, preferenceId: id, sources: knownSources(sources) };
}

export function toRunView(run: StoredJobRun): JobRun {
  const { id, ...rest } = run;
  return { ...rest, runId: id };
}

export function toEventView(event: StoredJobRunEvent): JobRunEvent {
  const { id, ...rest } = event;
  return { ...rest, eventId: id };
}

export function toIntentView(intent: StoredSubmitIntent): SubmitIntent {
  const { id, job, ...rest } = intent;
  return {
    ...rest,
    intentId: id,
    job: job as SubmitIntentJob,
  };
}

export function toRunViewData(view: AgentRunViewData): {
  run: JobRun;
  events: JobRunEvent[];
  intents: SubmitIntent[];
} {
  return {
    run: toRunView(view.run),
    events: view.events.map(toEventView),
    intents: view.intents.map(toIntentView),
  };
}
