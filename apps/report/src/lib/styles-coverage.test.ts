/**
 * 样式覆盖守护（2026-10-10 UI 排查新增）：
 * 组件/页面 class 里出现的项目类名（ja-* 与各组件 BEM 前缀），
 * 必须能在已加载的样式表（styles/*.css）或文件内联 <style> 中找到定义。
 *
 * 背景：搜岗工作台的 search-workbench__* 样式曾只放在 report-page.css，
 * 而工作台页从未引入该文件，导致生产 UI 完全无样式；此类回归靠肉眼难以发现，
 * 故固化为测试。新增组件类名时，样式必须同步落进对应页面会加载的样式表。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const srcDir = fileURLToPath(new URL('..', import.meta.url));

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (['node_modules', 'dist', '.astro'].includes(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(tsx|astro|css)$/.test(entry)) out.push(full);
  }
  return out;
}

const sourceFiles = walk(srcDir);

// 可用定义 = 全部 styles/*.css + 各文件内联 <style> 块
const cssBundle = sourceFiles
  .map((file) => {
    const src = readFileSync(file, 'utf8');
    if (file.endsWith('.css')) return src;
    return [...src.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n');
  })
  .join('\n');

const defined = new Set(
  [...cssBundle.matchAll(/\.([a-zA-Z][a-zA-Z0-9_-]*)/g)].map((m) => m[1]),
);

const PROJECT_CLASS =
  /^(ja-|search-workbench|agent-|model-settings|admin-catalog|workbench-|analyze-|claim-|ivp-|gate-|report-|recruit-|landing-|profile-|job-|match-|resume-|share-|evidence|signal|skill|stat|alert|empty|loading|notice|banner|panel|timeline|compare|fusion|gated|interview|improve)/;

const used = new Map<string, string>();
for (const file of sourceFiles) {
  const src = readFileSync(file, 'utf8');
  for (const m of src.matchAll(/class(?:Name)?=\{?["'`]([a-zA-Z0-9_ \-]+)["'`]/g)) {
    for (const cls of m[1].split(/\s+/).filter(Boolean)) {
      if (PROJECT_CLASS.test(cls) && !used.has(cls)) {
        used.set(cls, relative(srcDir, file));
      }
    }
  }
}

describe('styles coverage guard', () => {
  const missing = [...used.entries()].filter(([cls]) => !defined.has(cls));

  it('every project class used in markup has a CSS definition', () => {
    expect(
      missing.map(([cls, file]) => `${cls} (${file})`),
      `classes used but never defined: ${missing.map(([c]) => c).join(', ')}`,
    ).toEqual([]);
  });
});
