/**
 * 迁移 CLI 的目标库解析（纯函数）。
 *
 * 存在的原因：`createStorage()` 读 `process.env.DB_PATH`，而迁移 CLI 早期只认位置参数、
 * 缺省硬编仓库根的 `data/job-agent.db`，两者可以指向不同的库——按 `DB_PATH=… pnpm migrate:up`
 * 会把迁移打到本机开发库上（2026-09-24 真实踩到，见 handoff item55）。这里把优先级收成
 * 一个可单测的纯函数，CLI 与调用方共用同一条规则。
 */

export type SqlitePathSource = 'argument' | 'DB_PATH' | 'default';

export interface ResolvedSqlitePath {
  path: string;
  /** 路径由哪一层决定，CLI 会原样打出来，避免操作者对不上库 */
  source: SqlitePathSource;
}

const present = (value: string | undefined): value is string =>
  value !== undefined && value.trim() !== '';

/**
 * 解析 SQLite 目标库，优先级：命令行显式路径（`--db` 或位置参数）> `DB_PATH` > 缺省值。
 * 空白值按未设置处理；选中值原样返回（不 resolve），与 `createStorage()` 的 cwd 相对语义保持一致。
 */
export function resolveSqliteDbPath(input: {
  argument?: string | undefined;
  env?: NodeJS.ProcessEnv;
  defaultPath: string;
}): ResolvedSqlitePath {
  const env = input.env ?? process.env;
  if (present(input.argument)) return { path: input.argument, source: 'argument' };
  if (present(env.DB_PATH)) return { path: env.DB_PATH, source: 'DB_PATH' };
  return { path: input.defaultPath, source: 'default' };
}
