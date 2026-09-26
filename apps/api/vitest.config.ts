import { defineConfig } from 'vitest/config';

// apps/api 的单元/集成测试。T29：显式 testTimeout 给 interviews / resume 等
// 真实 SQLite 链路用例留余量（此前走 vitest 默认 5s，负载下偶发假红）。
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    environment: 'node',
    testTimeout: 15000,
    hookTimeout: 15000,
  },
});
