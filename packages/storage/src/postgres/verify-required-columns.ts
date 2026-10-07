import type { ColumnRequirement } from '../types.js';

/**
 * 迁移漂移守卫（Postgres 方言）：直接查 information_schema.columns，返回缺失的
 * "table.column" 列表。一次取全 public schema 的 表.列 集合再逐条比对；
 * 信息模式不含业务账本，手工重放的迁移也能如实反映。
 */
export async function pgVerifyRequiredColumns(
  client: { unsafe<T>(sql: string): Promise<unknown> },
  requirements: ColumnRequirement[],
): Promise<string[]> {
  const rows = (await client.unsafe<{ k: string }[]>(
    "SELECT table_name || '.' || column_name AS k FROM information_schema.columns WHERE table_schema = 'public'",
  )) as Array<{ k: string }>;
  const present = new Set(rows.map((r) => r.k));
  return requirements.map((r) => `${r.table}.${r.column}`).filter((k) => !present.has(k));
}
