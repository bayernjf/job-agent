/**
 * CLI 侧唯一的存储装配点：解析目标库 → 建好父目录 → createStorage()。
 *
 * 目标库优先级与迁移 CLI 同一条规则（AGENTS.md `pnpm migrate:up`）：显式 `dbPath`（等价 `--db`）
 * > `DB_PATH` > 缺省 `data/job-agent.db`。缺省值刻意保持**相对路径**：createStorage 按 cwd 解析，
 * 换成仓库根绝对路径会让「在 apps/cli 目录下跑命令」静默换库。
 *
 * 与迁移 CLI 的另一处差异：这里**不打印**选中的路径与来源。各子命令一直是静默的，多一行 stdout
 * 会污染 `--format json` 的输出与依赖它的脚本。
 */

import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { createStorage, type StorageContext } from '@jobagent/storage';
import type { CliDeps } from './index.js';

const DEFAULT_SQLITE_PATH = 'data/job-agent.db';

export interface CliStorageOptions {
  /** 命令行显式库路径；未传时回落 DB_PATH，再回落缺省值 */
  dbPath?: string;
}

/** 按优先级选出目标库路径，不碰文件系统（可单测）。 */
export function resolveCliSqlitePath(options: CliStorageOptions = {}): string {
  return options.dbPath ?? process.env.DB_PATH ?? DEFAULT_SQLITE_PATH;
}

/** 建库连接：非只读，因此 createStorage 默认 autoMigrate=true（本地库缺表时直接补齐）。 */
export async function createCliStorage(options: CliStorageOptions = {}): Promise<StorageContext> {
  const sqlitePath = resolveCliSqlitePath(options);
  mkdirSync(path.dirname(path.resolve(sqlitePath)), { recursive: true });
  return createStorage({ sqlitePath });
}

/** 命令统一入口：测试注入的 deps.storage 优先，命中时完全绕过路径解析与建目录。 */
export async function resolveCliStorage(
  deps: Pick<CliDeps, 'storage'>,
  options: CliStorageOptions = {},
): Promise<StorageContext> {
  return deps.storage ?? (await createCliStorage(options));
}
