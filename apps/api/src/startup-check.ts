/**
 * 启动时 schema 自检（T1-4，deferred「迁移漂移守卫」剩余项）。
 *
 * /health?deep=1 只在被请求时检查，且 serverless 冷启动无人调用时漂移会静默；
 * 常驻进程（本地/自托管/Docker）在启动时主动核对一次代码所需关键列：
 *   - 默认只告警、不退出（开发库未迁移时仍可启动）；
 *   - SCHEMA_CHECK_STRICT=1 时缺失列阻断启动（exit 1），生产建议开启。
 * Vercel serverless 入口不经过 main()，其漂移面仍由 /health?deep=1 与
 * cron 心跳失败覆盖。
 */
import type { ColumnRequirement } from '@jobagent/storage';

export interface StartupSchemaCheckResult {
  ok: boolean;
  missing: string[];
}

export interface SchemaCheckStorage {
  verifyRequiredColumns(requirements: ColumnRequirement[]): Promise<string[]>;
}

/** 执行一次启动自检，返回缺失列（"table.column"）清单。 */
export async function runStartupSchemaCheck(
  storage: SchemaCheckStorage,
  required: ColumnRequirement[],
): Promise<StartupSchemaCheckResult> {
  const missing = await storage.verifyRequiredColumns(required);
  return { ok: missing.length === 0, missing };
}

/** 把缺失列清单渲染成一行告警文案（纯函数，便于单测）。 */
export function formatSchemaWarning(missing: string[]): string {
  return `[api] schema check: ${missing.length} required column(s) missing: ${missing.join(', ')}`;
}
