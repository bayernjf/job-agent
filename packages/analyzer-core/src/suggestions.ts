/**
 * improvementSuggestions：画像里的"怎么变更好"（T09 产 / T10 渲染）。
 *
 * 硬约束与内核一致：纯函数、无 I/O、只基于采集输入的事实字段，每条必须挂
 * 真实存在的 evidenceRefs（无证据不下结论）；拿不准的维度一律不产，绝不
 * 为凑数编建议。
 *
 * 文案不在本文件里：每条只带一个稳定 `code`，句子由 `shared` 的
 * `composeImprovementSuggestion(code, locale)` 现拼（与 headline 同一套路）。
 * 存进快照的 `suggestion`/`why` 是**数据层英文原文**（按 'en' 拼出，供 API/CLI/存档），
 * 报告页按读者语言重新拼——两侧同源，不会漂成两种口径。
 */

import {
  composeImprovementSuggestion,
  type AbilityProfile,
  type ImprovementSuggestion,
  type ImprovementSuggestionCode,
} from '@jobagent/shared';
import type { AnalyzerInput } from './input.js';

function refsByType(input: AnalyzerInput, sourceType: string, n: number): string[] {
  return input.evidence
    .filter((e) => e.sourceType === sourceType)
    .slice(0, n)
    .map((e) => e.evidenceId);
}

function item(code: ImprovementSuggestionCode, evidenceRefs: string[]): ImprovementSuggestion {
  return { code, ...composeImprovementSuggestion(code, 'en'), evidenceRefs };
}

/**
 * 保守建议集：两条独立规则，各自命中才产（可同时命中，也可一条不产）。
 * - no_pull_requests：提交量不少但从未开 PR → 建议把代码带进评审流程。
 * - no_external_contributions：有 PR 但没有一项落到别人仓库并被合并 → 建议做外部贡献。
 * 两条都只依赖 commits/PR 的结构化事实与对应证据，缺证据即不产。
 */
export function computeImprovementSuggestions(
  input: AnalyzerInput,
): AbilityProfile['improvementSuggestions'] {
  const items: ImprovementSuggestion[] = [];

  if (input.pullRequests.length === 0 && input.commits.length >= 10) {
    const commitRefs = refsByType(input, 'commit', 3);
    if (commitRefs.length > 0) {
      items.push(item('no_pull_requests', commitRefs));
    }
  }

  const mergedExternal = input.pullRequests.filter(
    (p) => !p.repoOwnerIsSelf && p.state === 'MERGED',
  );
  if (mergedExternal.length === 0 && input.pullRequests.length > 0) {
    const prRefs = refsByType(input, 'pr', 2);
    if (prRefs.length > 0) {
      items.push(item('no_external_contributions', prRefs));
    }
  }

  return items.length > 0 ? items : undefined;
}
