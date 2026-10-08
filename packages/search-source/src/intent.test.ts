/**
 * 意图解析确定性测试：规则回落（P0 执行路径）覆盖中英混合指令、
 * 远程/坐班、薪资、城市、关键词；LLM 注入点保留（fail-closed 语义）。
 */
import { describe, expect, it } from 'vitest';
import { parseSearchIntent, ruleFallback, buildQueries } from './intent.js';

describe('ruleFallback', () => {
  it('parses a mixed zh/en command into structured conditions', () => {
    const c = ruleFallback('深圳的 Java 开发，坐班，可远程');
    expect(c.location).toBe('深圳');
    expect(c.remote).toBe(true);
    expect(c.queries.length).toBeGreaterThan(0);
    expect(c.queries[0]).toContain('深圳');
    expect(c.keywords).toContain('Java');
  });

  it('detects explicit remote wording (Chinese and English)', () => {
    expect(ruleFallback('远程 React 岗位').remote).toBe(true);
    expect(ruleFallback('remote python backend').remote).toBe(true);
    expect(ruleFallback('坐班 Go 工程师').remote).toBe(false);
    expect(ruleFallback('on-site node job').remote).toBe(false);
  });

  it('extracts a USD salary floor', () => {
    const c = ruleFallback('python backend, salary $120k-$150k');
    expect(c.salaryMinUsd).toBe(120000);
  });

  it('never fabricates fields that are absent', () => {
    const c = ruleFallback('find me a job');
    expect(c.location).toBeNull();
    expect(c.remote).toBe(false);
    expect(c.salaryMinUsd).toBeNull();
    expect(c.queries.length).toBeGreaterThan(0);
  });
});

describe('buildQueries', () => {
  it('dedupes variants and caps at 5', () => {
    const qs = buildQueries('深圳 Java 开发 坐班 可远程', '深圳', true);
    expect(qs.length).toBeLessThanOrEqual(5);
    expect(new Set(qs).size).toBe(qs.length);
    expect(qs[0]).toContain('远程');
  });
});

describe('parseSearchIntent', () => {
  it('falls back to rules without an LLM client', async () => {
    const c = await parseSearchIntent('上海 Golang 远程');
    expect(c.location).toBe('上海');
    expect(c.remote).toBe(true);
  });
});
