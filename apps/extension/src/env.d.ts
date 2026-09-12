/**
 * 构建期由 esbuild define 注入（build.mjs 的 EXTENSION_API_BASE）。
 * 让 tsc typecheck 通过；运行时被替换为实际值。
 */
declare const EXTENSION_API_BASE: string;
