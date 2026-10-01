/**
 * 模块图守护（设计 §8 验收）：apps/mcp 只能 import @jobagent/api 与 @jobagent/shared，
 * 绝不直接 import @jobagent/storage——直读会绕过授权分级闸。
 *
 * 测试夹具（test-harness.ts）允许直接用 storage 灌数据，但产品代码（server/tools/config）
 * 不允许。这里静态扫描产品源文件的 import 语句。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));

const PRODUCT_FILES = ['config.ts', 'rate-limiter.ts', 'tools.ts', 'server-factory.ts', 'server.ts', 'index.ts'];

describe('module graph guard (MCP is a thin shell over the HTTP API)', () => {
  it('product sources never import @jobagent/storage directly', () => {
    for (const file of PRODUCT_FILES) {
      const src = readFileSync(join(here, file), 'utf8');
      expect(src, `${file} must not import @jobagent/storage`).not.toMatch(
        /from ['"]@jobagent\/storage['"]/,
      );
    }
  });

  it('tools layer reaches data only through a request() interface, not a repo handle', () => {
    const tools = readFileSync(join(here, 'tools.ts'), 'utf8');
    expect(tools).not.toMatch(/createStorage|repos\.|StorageContext/);
    expect(tools).toMatch(/request\(/);
  });

  it('only invokes the four allowed read-only endpoints (never analyze/resume/demo/interviews)', () => {
    // Only tools.ts actually issues HTTP requests. Inspect quoted path literals so that
    // words like "/analyze" appearing in comments are not mistaken for real calls.
    const tools = readFileSync(join(here, 'tools.ts'), 'utf8');
    const pathLiterals = [...tools.matchAll(/[`'"]\s*(\/[A-Za-z0-9_:${}/?=&,-]*)/g)].map((m) => m[1]!);
    expect(pathLiterals.length).toBeGreaterThanOrEqual(4); // anti-empty: four endpoints, >=1 literal each
    for (const p of pathLiterals) {
      expect(p).not.toMatch(/^\/analyze/);
      expect(p).not.toMatch(/^\/resumes/);
      expect(p).not.toMatch(/^\/demo/);
      expect(p).not.toMatch(/\/interviews/);
    }
    // Interview questions must never enter the MCP projection/output.
    expect(tools).not.toMatch(/interviewQuestions/);
  });

  it('all expected source files are present (anti-empty-guard)', () => {
    const present = readdirSync(here);
    for (const f of [...PRODUCT_FILES, 'mcp-server.test.ts']) {
      expect(present).toContain(f);
    }
    expect(PRODUCT_FILES.length).toBe(6);
  });
});
