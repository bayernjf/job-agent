import { defineConfig } from 'vitest/config';

// Astro 报告页的单元测试（i18n 一致性等纯逻辑测试）。
// .astro 组件测试需要额外的 astro test 环境，MVP 暂只覆盖 src 下 *.test.ts。
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/.astro/**'],
    environment: 'node',
  },
});
