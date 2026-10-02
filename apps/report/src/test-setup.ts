/**
 * Vitest 全局 setup（仅报告页）：
 * - 注册 @testing-library/jest-dom 的 DOM matcher（toBeDisabled / toBeEmptyDOMElement 等）；
 * - vitest 默认 globals:false，@testing-library/react 无法自动注册 afterEach cleanup，
 *   这里显式在每个用例后卸载组件，避免 DOM 跨用例残留。
 * 对纯 node 环境的 *.test.ts 同样运行，但注册 matcher 与空 cleanup 均无副作用。
 */
import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

afterEach(() => {
  cleanup();
});
