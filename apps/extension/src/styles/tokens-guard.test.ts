/**
 * 设计 token 守护测试（design-tokens-20260910.md 第 6、8.4 节）：
 * 扩展组件源码中不得出现颜色字面量（hex / rgb()/rgba()/hsl()），
 * 颜色只能来自共享 token（packages/ui-tokens）里的 var(--ja-*)。
 *
 * 结构性 px 尺寸（1px 边框、999px 胶囊、定位锚点）不在本扫描范围，
 * 由 review 按设计文档第 5、8.3 节约束。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const sources = {
  panelCss: fileURLToPath(new URL('../content/panel.css', import.meta.url)),
  panelTsx: fileURLToPath(new URL('../content/panel.tsx', import.meta.url)),
  contentTsx: fileURLToPath(new URL('../content/index.tsx', import.meta.url)),
};

const HEX_COLOR = /#[0-9a-fA-F]{3,8}\b/;
const COLOR_FUNC = /(^|[^\w-])(rgb|rgba|hsl|hsla)\s*\(/i;

describe('extension design-token guard', () => {
  for (const [name, file] of Object.entries(sources)) {
    const code = readFileSync(file, 'utf8');

    it(`${name} contains no hex color literals`, () => {
      const match = code.match(HEX_COLOR);
      expect(match, `found hex color "${match?.[0]}" in ${name}; use var(--ja-*)`).toBeNull();
    });

    it(`${name} contains no rgb()/hsl() color functions`, () => {
      const match = code.match(COLOR_FUNC);
      expect(match, `found color function in ${name}; use var(--ja-*)`).toBeNull();
    });
  }

  it('panel.css consumes tokens via var(--ja-*)', () => {
    const css = readFileSync(sources.panelCss, 'utf8');
    expect(css).toContain('var(--ja-color-');
    expect(css).toContain('var(--ja-space-');
    expect(css).toContain('var(--ja-radius-');
  });
});
