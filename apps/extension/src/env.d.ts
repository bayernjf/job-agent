/**
 * 构建期由 esbuild define 注入（build.mjs 的 EXTENSION_API_BASE /
 * EXTENSION_SITE_ORIGIN / EXTENSION_RELEASE）。
 * 让 tsc typecheck 通过；运行时被替换为实际值。
 */
declare const EXTENSION_API_BASE: string;
declare const EXTENSION_SITE_ORIGIN: string;
/** true＝CWS release 构建：localhost/127.0.0.1 授权与白名单必须全部剥离 */
declare const EXTENSION_RELEASE: boolean;
