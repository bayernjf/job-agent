import { defineConfig } from 'vitest/config';

// 决策 #28（审查 §1.3）：本包此前没有 vitest.config.ts，吃默认 testTimeout 5000。
// real-dom-regression 的两个 Lever 用例单跑就要 2.4–3.8s（零余量），并行跑
// `pnpm -r test` 时同一 SHA 会假红。与 api/report（15000）、storage（30000）
// 对齐；T29 约束的是单个用例内部不得用 timeout 掩盖竞态，包级预算不在此列。
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    testTimeout: 15000,
    hookTimeout: 15000,
  },
});
