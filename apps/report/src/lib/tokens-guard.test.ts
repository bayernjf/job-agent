/**
 * 报告页设计 token 守护（design-tokens-20260910.md 第 6、8.4 节；审计项 T3）：
 * 报告页组件与全局样式中不得出现颜色字面量（hex / rgb()/rgba()/hsl()），
 * 颜色只能来自共享 token（@jobagent/ui-tokens）里的 var(--ja-*)。
 *
 * 扩展侧已有同类守护（apps/extension/src/styles/tokens-guard.test.ts），
 * 本文件为报告页补齐。结构性 px 尺寸（1px 边框、定位锚点）不在颜色扫描范围。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const stylesDir = fileURLToPath(new URL('../styles', import.meta.url));
const componentsDir = fileURLToPath(new URL('../components', import.meta.url));

const componentFiles = readdirSync(componentsDir).filter((f) => f.endsWith('.tsx'));
const globalCss = `${stylesDir}/global.css`;

const HEX_COLOR = /#[0-9a-fA-F]{3,8}\b/;
const COLOR_FUNC = /(^|[^\w-])(rgb|rgba|hsl|hsla)\s*\(/i;

describe('report design-token guard', () => {
  for (const file of componentFiles) {
    const code = readFileSync(`${componentsDir}/${file}`, 'utf8');

    it(`component ${file} contains no hex color literals`, () => {
      const match = code.match(HEX_COLOR);
      expect(match, `found hex color "${match?.[0]}" in ${file}; use var(--ja-*)`).toBeNull();
    });

    it(`component ${file} contains no rgb()/hsl() color functions`, () => {
      const match = code.match(COLOR_FUNC);
      expect(match, `found color function in ${file}; use var(--ja-*)`).toBeNull();
    });
  }

  it('global.css contains no hex color literals', () => {
    const css = readFileSync(globalCss, 'utf8');
    const match = css.match(HEX_COLOR);
    expect(match, `found hex color "${match?.[0]}" in global.css; use var(--ja-*)`).toBeNull();
  });

  it('global.css consumes color/space/radius tokens via var(--ja-*)', () => {
    const css = readFileSync(globalCss, 'utf8');
    expect(css).toContain('var(--ja-color-');
    expect(css).toContain('var(--ja-space-');
    expect(css).toContain('var(--ja-radius-');
  });
});
