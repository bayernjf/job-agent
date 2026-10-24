import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

/**
 * 审查动作 #7：仓库此前没有任何 ESLint，13 处 `eslint-disable` 实际是死注释
 * （没有 linter 读取它们），其中 6 处 react-hooks/exhaustive-deps 压在状态最重的
 * 组件上。这里只接非类型感知的 recommended 规则集，先把真实违规量跑出来，
 * 不引入 type-aware 规则（会要求每个包配 project service，成本远大于收益）。
 */
export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.astro/**',
      '**/.vercel/**',
      '**/build/**',
      'apps/extension/dist/**',
      'data/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx,mjs,js}'],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
      parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // 约定：未使用参数/变量用 `_` 前缀显式标记（与本仓既有写法一致）
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      // react-hooks v7 的 Compiler 系规则：本仓大量组件是 fetch-on-mount（effect 内
      // setState）与"回调引用后声明的 useCallback"，接 React Compiler 是独立工程，
      // 先只保留 rules-of-hooks / refs / exhaustive-deps 这三条有回归价值的规则。
      'react-hooks/set-state-in-effect': 'off',
      'react-hooks/immutability': 'off',
    },
  },
  {
    // 测试/E2E/一次性工具允许 any（mock 与脱敏夹具常需要），生产代码仍禁止。
    files: [
      '**/*.test.ts',
      '**/*.test.tsx',
      'e2e/**/*.ts',
      'tools/**/*.js',
      'apps/*/src/test-harness.ts',
    ],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
);
