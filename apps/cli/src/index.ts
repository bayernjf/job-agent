/**
 * jobagent CLI（M1·W2）：命令行对真实 GitHub 账号出能力画像，不起 Web。
 * 供决策 #8 的 20–50 账号去风险实验：批量导出 JSONL。
 *
 * 用法：
 *   jobagent analyze <user> [--out <file>]      # 单账号 → JSON（stdout 或文件）
 *   jobagent batch <file> [--out <file>]        # 每行一个用户名 → JSONL
 *
 * 凭证：环境变量 GITHUB_TOKEN（本地 PAT，见 .env.example；绝不下发前端/不入 Git）。
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { analyze, type AnalyzerInput } from '@jobagent/analyzer-core';
import { GitHubSource, type GitHubCollectedData } from '@jobagent/github-source';
import { toHtml, toMarkdown } from './report-format.js';

export interface CliDeps {
  /** 环境变量 GITHUB_TOKEN 的值（由调用方注入，便于测试） */
  token?: string;
  /** 采集器注入点（测试用 fake；生产默认 new GitHubSource） */
  source?: { collect(login: string): Promise<GitHubCollectedData> };
  logger?: Pick<Console, 'error' | 'warn' | 'info' | 'log'>;
  /** 注入"现在"（测试确定性）；默认 new Date().toISOString() */
  now?: () => string;
  /** 注入 stdout（测试捕获）；默认 process.stdout */
  stdout?: { write(chunk: string): unknown };
}

export interface AnalyzeResult {
  profile: ReturnType<typeof analyze>;
  meta: GitHubCollectedData['meta'];
}

function makeSource(deps: CliDeps): { collect(login: string): Promise<GitHubCollectedData> } {
  if (deps.source) return deps.source;
  const token = deps.token;
  if (!token) {
    throw new CliError(
      'GITHUB_TOKEN is not set. Create a fine-grained PAT (public repo read-only) and put it in the environment or .env (see .env.example).',
      1,
    );
  }
  return new GitHubSource({ token, log: deps.logger ?? console });
}

class CliError extends Error {
  constructor(message: string, readonly exitCode: number) {
    super(message);
    this.name = 'CliError';
  }
}

export async function analyzeLogin(
  login: string,
  deps: CliDeps,
): Promise<AnalyzeResult> {
  const source = makeSource(deps);
  const collected = await source.collect(login);
  const profile = analyze(collected.input as AnalyzerInput, {
    profileId: randomUUID(),
    claimed: false,
  });
  return { profile, meta: collected.meta };
}

function readBatchFile(file: string): string[] {
  const content = readFileSync(file, 'utf8');
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

function writeOutput(
  outFile: string | undefined,
  content: string,
  logger: Pick<Console, 'log'>,
  stdout: { write(chunk: string): unknown },
): void {
  if (outFile) {
    mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
    writeFileSync(outFile, content, 'utf8');
    logger.log(`Wrote ${outFile}`);
  } else {
    stdout.write(content);
  }
}

function renderProfile(result: AnalyzeResult, format: string): string {
  const p = result.profile;
  if (format === 'markdown' || format === 'md') return toMarkdown(p);
  if (format === 'html') return toHtml(p);
  return JSON.stringify(result, null, 2);
}

export async function run(argv: string[], deps: CliDeps): Promise<number> {
  const logger = deps.logger ?? console;
  const stdout = deps.stdout ?? process.stdout;
  const [command, ...rest] = argv;

  if (command === 'analyze') {
    const { values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: { out: { type: 'string', short: 'o' } },
    });
    const login = positionals[0];
    if (!login) {
      logger.error('Usage: jobagent analyze <user> [--out <file>] [--format json|markdown|html]');
      return 2;
    }
    try {
      const result = await analyzeLogin(login, deps);
      const json = JSON.stringify(result, null, 2);
      writeOutput(values.out, json, logger, stdout);
      return 0;
    } catch (err) {
      logger.error(`analyze failed for ${login}: ${(err as Error).message}`);
      return 1;
    }
  }

  if (command === 'batch') {
    const { values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: { out: { type: 'string', short: 'o' } },
    });
    const file = positionals[0];
    if (!file) {
      logger.error('Usage: jobagent batch <file> [--out <file>]   # file: one username per line');
      return 2;
    }
    let logins: string[];
    try {
      logins = readBatchFile(file);
    } catch (err) {
      logger.error(`cannot read batch file: ${(err as Error).message}`);
      return 1;
    }
    if (logins.length === 0) {
      logger.error('batch file is empty (one username per line, # for comments)');
      return 1;
    }
    const lines: string[] = [];
    let failed = 0;
    for (const login of logins) {
      try {
        const result = await analyzeLogin(login, deps);
        lines.push(JSON.stringify(result));
        logger.log(`ok ${login}`);
      } catch (err) {
        failed += 1;
        logger.error(`failed ${login}: ${(err as Error).message}`);
        lines.push(JSON.stringify({ login, error: (err as Error).message }));
      }
    }
    const content = `${lines.join('\n')}\n`;
    writeOutput(values.out, content, logger, stdout);
    logger.log(`batch done: ${logins.length} total, ${failed} failed`);
    return failed > 0 ? 1 : 0;
  }

  logger.error(
    'Usage: jobagent analyze <user> [--out <file>] [--format json|markdown|html] | batch <file> [--out <file>]',
  );
  return 2;
}

async function main(): Promise<void> {
  const code = await run(process.argv.slice(2), {
    token: process.env.GITHUB_TOKEN,
  });
  process.exitCode = code;
}

main().catch((err) => {
  console.error(`jobagent: ${(err as Error).message}`);
  process.exitCode = 1;
});
