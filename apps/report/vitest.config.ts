import { defineConfig } from 'vitest/config';

// Astro 报告页的单元测试：
// - 纯逻辑测试（i18n、守护、lib）跑 node 环境；
// - React island 组件测试（*.test.tsx）用文件顶部 `// @vitest-environment jsdom`
//   单独切到 jsdom，不影响其余纯 node 测试。
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/.astro/**'],
    environment: 'node',
    setupFiles: ['./src/test-setup.ts'],
  },
});
