import { defineConfig } from 'vitest/config';

// 决策 #28（审查 §1.3）：本包此前没有 vitest.config.ts，吃默认 testTimeout 5000。
// real-dom-regression 的 Lever 样本是 700KB 整页 HTML，其内联 <style> 曾让 jsdom
// 单样本解析耗时 ~1s（CSSOM 与本套件无关）；评审 P2-3 已把样式表正文剥离，
// 解析降到 ~50ms（2026-11-03 实测）。15s 预算保留为 CI 负载波动下的余量，
// 不再承担"掩盖 CPU 开销"的角色。T29 约束的是单个用例内部不得用 timeout 掩盖竞态，
// 包级预算不在此列。
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    testTimeout: 15000,
    hookTimeout: 15000,
  },
});
