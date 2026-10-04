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
    // 审计 T2：默认 5s 在并行全仓跑时会因 CPU 争用把慢盘/重 transform 的用例判成超时假红
    // （api 15s、storage 30s 已各自显式设置，本包此前漏了）。留 3 倍余量，不是把真慢测试藏起来。
    testTimeout: 15000,
  },
});
