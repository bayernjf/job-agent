/**
 * 文档锚点可解析性守护（第五条"文档即被测面"守护）。
 *
 * 为什么前四条抓不到：api-doc-consistency 只比路由名、env-doc-consistency 只比 env 键、
 * doc-links 只验**文件**可达、doc-commands 只验命令可跑——**没有任何一条看行号**。
 * 2026-10-03 工程债批次把 `apps/api/src/index.ts` 从 2691 行拆成 275 行 + `routes/*` 之后，
 * 两份核心文档里 **19 处** `file:line` 证据锚点当场指向不存在的行，而全部门禁仍绿
 * （`docs/代码审计与功能全景-20260930.md` §7.1 记了这条发现与逐处数字）。
 * 本仓库的审计口径是"每条结论可回溯到 file:line"，锚点腐烂＝证据链静默失效。
 *
 * 实现单一事实源在 `tools/check-doc-anchors.mjs`（也可手工跑），本用例只负责把它接进
 * `pnpm -r test` 与 CI，并做**反空转断言**：必须真的解析到足够多的引用，
 * 否则正则会退化成"扫了个寂寞也算绿"。
 *
 * 只读文件、零网络。归档与"某日评审"按仓库惯例是时间点记录，由脚本排除。
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '../../..');
const SCRIPT = resolve(REPO_ROOT, 'tools/check-doc-anchors.mjs');

/** 活文档里的锚点引用数量级（10-04 实测 163 处）；大幅下跌说明正则或扫描范围被改坏。 */
const MIN_REFS = 120;

describe('doc anchors 可解析性', () => {
  const run = () =>
    execFileSync(process.execPath, [SCRIPT], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

  it('全仓活文档里的 path:line 都能解析到真实行', () => {
    let stdout = '';
    try {
      stdout = run();
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; status?: number };
      // 违例时脚本 exit 1 并逐条打印：把明细带进断言消息，否则 CI 里只看到一个红
      throw new Error(
        `文档锚点越界（exit ${e.status}）：\n${(e.stdout ?? '') + (e.stderr ?? '')}`,
      );
    }
    expect(stdout).toContain('违例 0 处');
  });

  it('确实解析到了足量引用（反空转）', () => {
    const stdout = run();
    const refs = Number(stdout.match(/引用 (\d+) 处/)?.[1] ?? 0);
    const files = Number(stdout.match(/扫描 (\d+) 个 markdown/)?.[1] ?? 0);
    expect(refs).toBeGreaterThanOrEqual(MIN_REFS);
    expect(files).toBeGreaterThanOrEqual(50);
  });

  it('脚本对已知坏例会红（证明它不是永真）', () => {
    // 临时文档引用一个不可能存在的行号，断言脚本以非零退出。
    const badDoc = join(tmpdir(), 'ja-anchor-probe.md');
    writeFileSync(badDoc, 'probe: `apps/api/src/index.ts:999999` 应当越界\n');
    try {
      let status = 0;
      try {
        execFileSync(process.execPath, [SCRIPT, badDoc], {
          cwd: REPO_ROOT,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (err) {
        status = (err as { status?: number }).status ?? 0;
      }
      expect(status).not.toBe(0);
    } finally {
      rmSync(badDoc, { force: true });
    }
  });
});
