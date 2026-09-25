/**
 * improvementSuggestions：画像里的"怎么变更好"（T09，C 端 P1 落地产出）。
 *
 * 硬约束与内核一致：纯函数、无 I/O、只基于采集输入的事实字段，每条必须挂
 * 真实存在的 evidenceRefs（无证据不下结论）；拿不准的维度一律不产，绝不
 * 为凑数编建议。产出为数据层英文散文（与 caveats/prSummary 同口径），
 * 报告/简历渲染暂不消费本字段，待 T23 模板化收口时统一随读者语言。
 */

import type { AbilityProfile } from '@jobagent/shared';
import type { AnalyzerInput } from './input.js';

export interface ImprovementSuggestionItem {
  suggestion: string;
  why: string;
  evidenceRefs: string[];
}

function refsByType(input: AnalyzerInput, sourceType: string, n: number): string[] {
  return input.evidence
    .filter((e) => e.sourceType === sourceType)
    .slice(0, n)
    .map((e) => e.evidenceId);
}

/**
 * 保守建议集：两条独立规则，各自命中才产（可同时命中，也可一条不产）。
 * - PR 协作缺失：提交量不少但从未开 PR → 建议把代码带出个人仓库走协作流程。
 * - 外部贡献缺失：有 PR 但全在自有仓库 → 建议向外部项目提交贡献。
 * 两条都只依赖 commits/PR 的结构化事实与对应证据，缺字段即不产。
 */
export function computeImprovementSuggestions(
  input: AnalyzerInput,
): AbilityProfile['improvementSuggestions'] {
  const items: ImprovementSuggestionItem[] = [];

  if (input.pullRequests.length === 0 && input.commits.length >= 10) {
    const commitRefs = refsByType(input, 'commit', 3);
    if (commitRefs.length > 0) {
      items.push({
        suggestion:
          'Move code contributions beyond personal repositories: open pull requests and engage with the review process.',
        why:
          'All recorded commits stay within the subject\'s own repositories; no pull request was opened, which limits visibility of collaboration skills.',
        evidenceRefs: commitRefs,
      });
    }
  }

  const mergedExternal = input.pullRequests.filter(
    (p) => !p.repoOwnerIsSelf && p.state === 'MERGED',
  );
  if (mergedExternal.length === 0 && input.pullRequests.length > 0) {
    const prRefs = refsByType(input, 'pr', 2);
    if (prRefs.length > 0) {
      items.push({
        suggestion:
          'Contribute to external projects: submit pull requests to repositories outside your own.',
        why:
          'Every merged pull request points back to the subject\'s own repositories, so there is no evidence of cross-project collaboration.',
        evidenceRefs: prRefs,
      });
    }
  }

  return items.length > 0 ? items : undefined;
}
