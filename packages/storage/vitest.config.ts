import { defineConfig } from 'vitest/config';

// 显式排除 dist/：构建产物中的旧测试编译文件不得被重复执行
// （build 已用 tsconfig.build.json 排除 *.test.ts，此处为双保险）
export default defineConfig({
  test: {
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
});
