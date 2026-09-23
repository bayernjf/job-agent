import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 浏览器组件 API 请求的跨端口 cookie 守护（回归 item48/A5 修复）。
 *
 * 本地开发时报告页（:4321）与 API（:3000）跨端口：fetch 默认
 * credentials:'same-origin' 不会发送/保存会话 cookie，导致演示会话、
 * 登录态在跨端口全部失效。所有组件内的 API fetch 必须显式带
 * `credentials: 'include'`（同域生产行为不变）。
 *
 * 本测试用源码扫描 + 平衡括号提取，逐个 fetch 调用断言，防止被改回。
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const componentsDir = path.resolve(here, '../components');

/** 提取源码中所有 `name(...)` 调用的完整参数字符串（平衡括号，感知字符串）。 */
function extractCalls(src: string, name: string): string[] {
  const calls: string[] = [];
  const needle = `${name}(`;
  let searchFrom = 0;
  let idx: number;
  while ((idx = src.indexOf(needle, searchFrom)) !== -1) {
    const openParen = idx + needle.length - 1;
    let depth = 0;
    let quote: string | null = null;
    let end = -1;
    for (let i = openParen; i < src.length; i++) {
      const ch = src[i];
      if (quote) {
        if (ch === quote && src[i - 1] !== '\\') quote = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') {
        quote = ch;
      } else if (ch === '(') {
        depth++;
      } else if (ch === ')') {
        depth--;
        if (depth === 0) {
          end = i + 1;
          break;
        }
      }
    }
    if (end === -1) throw new Error(`unbalanced ${name}() call in source`);
    calls.push(src.slice(openParen, end));
    searchFrom = end;
  }
  return calls;
}

const componentFiles = readdirSync(componentsDir).filter((f) => f.endsWith('.tsx'));

describe('component API fetches carry credentials: include', () => {
  it.each(componentFiles)('%s: every fetch() sends credentials', (file) => {
    const src = readFileSync(path.join(componentsDir, file), 'utf8');
    const calls = extractCalls(src, 'fetch');
    for (const call of calls) {
      const compact = call.replace(/\s+/g, '');
      expect(compact, call).toContain("credentials:'include'");
    }
  });

  it('scanner actually covers the known fetch call sites', () => {
    // 防守护自身失效：当前组件至少有 15 处 fetch 调用。
    const total = componentFiles.reduce(
      (n, file) =>
        n +
        extractCalls(readFileSync(path.join(componentsDir, file), 'utf8'), 'fetch').length,
      0,
    );
    expect(total).toBeGreaterThanOrEqual(15);
  });
});
