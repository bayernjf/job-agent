/**
 * CLI semantic 子命令：L3 语义层（设计见 docs/design-semantic-layer-20261011.md）。
 * 用法：
 *   jobagent semantic analyze <user> [--repos N] [--out <file>] [--format json|markdown] [--llm]
 * --llm：启用 L3-B LLM 语义摘要（每画像 +1 次 LLM 调用、按决策 #21 双轨计费）；
 *        无 LLM_API_KEY 或 LLM 失败时 fail-closed 回落规则版（不伪造摘要）。
 * 凭证：GITHUB_TOKEN（与 analyze 同源）。
 */
import { parseArgs } from 'node:util';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { analyzeSemantic } from '@jobagent/semantic-core';
import { SemanticSource, type L3CollectedData } from '@jobagent/semantic-source';
import { createSemanticProviderFromEnv } from '@jobagent/llm';
import type { L3Signals } from '@jobagent/shared';
import type { CliDeps } from './index.js';

const USAGE =
  'Usage: jobagent semantic analyze <user> [--repos N] [--out <file>] [--format json|markdown] [--llm]';

export async function runSemantic(rest: string[], deps: CliDeps): Promise<number> {
  const logger = deps.logger ?? console;
  const stdout = deps.stdout ?? process.stdout;
  const [sub, ...subRest] = rest;

  if (sub !== 'analyze') {
    logger.error(USAGE);
    return 2;
  }

  const { values, positionals } = parseArgs({
    args: subRest,
    allowPositionals: true,
    options: {
      repos: { type: 'string' },
      out: { type: 'string', short: 'o' },
      format: { type: 'string' },
      llm: { type: 'boolean' },
    },
  });

  const login = positionals[0];
  if (!login) {
    logger.error(USAGE);
    return 2;
  }

  let reposN = 5;
  if (values.repos !== undefined) {
    reposN = Number(values.repos);
    if (!Number.isInteger(reposN) || reposN < 1 || reposN > 20) {
      logger.error('--repos must be an integer in 1..20 (default 5)');
      return 2;
    }
  }
  const format = values.format ?? 'json';
  if (!['json', 'markdown', 'md'].includes(format)) {
    logger.error('--format must be one of: json, markdown (default json)');
    return 2;
  }
  const withLlm = values.llm ?? false;

  try {
    const source: { collect(login: string): Promise<L3CollectedData> } =
      deps.semanticSource ?? makeSemanticSource(deps, reposN);
    const collected = await source.collect(login);
    let signals: L3Signals = analyzeSemantic(collected.input);

    if (withLlm) {
      signals = await attachLlmSummary(signals, collected, deps, logger);
    }

    const content =
      format === 'json'
        ? JSON.stringify({ collected: { meta: collected.meta }, signals }, null, 2)
        : renderMarkdown(login, collected, signals);

    if (values.out) {
      mkdirSync(path.dirname(path.resolve(values.out)), { recursive: true });
      writeFileSync(values.out, content, 'utf8');
      logger.log(`Wrote ${values.out}`);
    } else {
      stdout.write(content);
    }
    return 0;
  } catch (err) {
    logger.error(`semantic analyze failed for ${login}: ${(err as Error).message}`);
    return 1;
  }
}

/**
 * L3-B：LLM 语义摘要，fail-closed 规则回落。
 * 无 provider（未配 LLM_API_KEY）→ 提示并返回规则版；LLM 调用/校验失败 →
 * 只回退 llmSummary（不整命令失败），保证 CLI 输出始终可用。
 * （analyze --semantic --llm 与 semantic analyze --llm 共用）
 */
export async function attachLlmSummary(
  signals: L3Signals,
  collected: L3CollectedData,
  deps: CliDeps,
  logger: Pick<Console, 'error' | 'warn' | 'info' | 'log'>,
): Promise<L3Signals> {
  const provider = deps.semanticProvider ?? createSemanticProviderFromEnv();
  if (!provider) {
    logger.warn(
      '--llm requested but LLM_API_KEY is not set; using rule-based signals (no LLM summary).',
    );
    return signals;
  }
  try {
    const out = await provider.generate(collected.input);
    return {
      ...signals,
      llmSummary: {
        repoSummary: out.repoSummary,
        designDecisions: out.designDecisions,
        provider: provider.provider,
        model: provider.model,
      },
    };
  } catch (err) {
    // fail-closed：任何 LLM 失败（网络/HTTP/校验）都只回退 llmSummary，不整命令失败
    logger.warn(
      `LLM semantic summary failed (${(err as Error).message}); falling back to rule-based signals.`,
    );
    return signals;
  }
}

export function makeSemanticSource(
  deps: CliDeps,
  reposN: number,
): { collect(login: string): Promise<L3CollectedData> } {
  const token = deps.token;
  if (!token) {
    throw new Error(
      'GITHUB_TOKEN is not set. Create a fine-grained PAT (public repo read-only) and put it in the environment or .env (see .env.example).',
    );
  }
  return new SemanticSource({ token, reposN, log: deps.logger ?? console });
}

/** markdown 汇报：简体中文（只重述 code + facts，不推断） */
function renderMarkdown(
  login: string,
  collected: L3CollectedData,
  signals: ReturnType<typeof analyzeSemantic>,
): string {
  const lines: string[] = [];
  lines.push(`# L3 语义信号 — ${login}`);
  lines.push('');
  lines.push(`- 规则版本：\`${signals.ruleVersion}\`；扫描仓库 ${collected.meta.reposScanned} 个（REST ${collected.meta.restCalls} 次）`);
  lines.push('');
  if (signals.llmSummary) {
    lines.push(`**LLM 语义摘要**（${signals.llmSummary.provider}/${signals.llmSummary.model}）`);
    lines.push('');
    lines.push(signals.llmSummary.repoSummary);
    if (signals.llmSummary.designDecisions.length > 0) {
      lines.push('');
      lines.push('设计决策：');
      for (const d of signals.llmSummary.designDecisions) lines.push(`- ${d}`);
    }
    lines.push('');
  }
  if (signals.summary.techStack.length > 0) {
    lines.push(`**技术栈**：${signals.summary.techStack.join(', ')}`);
  }
  if (signals.summary.domainHints.length > 0) {
    lines.push(`**领域提示**：${signals.summary.domainHints.join(', ')}`);
  }
  lines.push('');
  for (const repo of signals.repos) {
    const m = repo.maturity;
    const missing = repo.missing.length > 0 ? `（缺失：${repo.missing.join('/')}）` : '';
    lines.push(
      `## ${repo.owner}/${repo.name}${missing}\n\n` +
        `- 仓库类型：${repo.repoKind}｜star：${m.starBand}（${repo.maturity.fileCount} 个文件）\n` +
        `- 工程成熟度：测试 ${m.hasTests ? '✓' : '✗'}｜CI ${m.hasCi ? '✓' : '✗'}｜文档 ${m.hasDocs ? '✓' : '✗'}｜许可证 ${m.hasLicense ? '✓' : '✗'}｜Docker ${m.hasDockerfile ? '✓' : '✗'}\n` +
        (repo.techStack.length > 0 ? `- 技术栈：${repo.techStack.join(', ')}\n` : '') +
        (repo.domainHints.length > 0 ? `- 领域提示：${repo.domainHints.join(', ')}\n` : ''),
    );
  }
  return lines.join('\n');
}
